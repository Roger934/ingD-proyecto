// Prueba de la lógica del vigilante con un clúster simulado en memoria (sin bases reales).
// Uso: cd api && npm run probar-vigilante
const Module = require('module');
const path = require('path');
const assert = require('assert');
const os = require('os');
process.env.ARCHIVO_ESTADO = path.join(os.tmpdir(), 'vigilante-prueba-' + Date.now() + '.json');
process.env.UMBRAL = '5';

// ---------- MySQL simulado ----------
const my = {};
const nuevoMy = (gtid) => ({ up: true, ro: true, sro: true, gtid: new Set(gtid), fuente: null, io: null });
function tickMy() { // la réplica copia del primario
  for (const n of Object.values(my)) {
    if (n.up && n.fuente && n.io === 'ON' && my[n.fuente] && my[n.fuente].up) for (const t of my[n.fuente].gtid) n.gtid.add(t);
  }
}
const gtxt = (s) => [...s].sort().join(',');
const gset = (t) => new Set(t ? t.split(',') : []);
const mysqlMock = {
  createConnection: async ({ host }) => {
    const n = my[host];
    if (!n || !n.up) throw Object.assign(new Error('connect ECONNREFUSED ' + host), { code: 'ECONNREFUSED' });
    return {
      end: async () => {},
      query: async (sql, p = []) => {
        if (!n.up) throw new Error('perdida');
        if (/@@global.read_only AS ro, @@global.gtid_executed/.test(sql)) return [[{ ro: n.ro ? 1 : 0, gtid: gtxt(n.gtid) }]];
        if (/replication_connection_configuration/.test(sql)) return [n.fuente ? [{ fuente: n.fuente, io: n.io, recibido: gtxt(n.gtid), error_io: '' }] : []];
        if (/replication_applier_status/.test(sql)) return [n.fuente ? [{ sql_estado: 'ON' }] : []];
        if (/GTID_SUBSET/.test(sql)) return [[{ ok: [...gset(p[0])].every((t) => n.gtid.has(t)) ? 1 : 0 }]];
        if (/WAIT_FOR_EXECUTED/.test(sql)) return [[{}]];
        if (/^STOP REPLICA/.test(sql)) { n.io = n.fuente ? 'OFF' : null; return [[]]; }
        if (/RESET REPLICA ALL/.test(sql)) { n.fuente = null; n.io = null; return [[]]; }
        if (/super_read_only = OFF/.test(sql)) { n.sro = false; return [[]]; }
        if (/super_read_only = ON/.test(sql)) { n.sro = true; n.ro = true; return [[]]; }
        if (/read_only = OFF/.test(sql)) { assert(!n.sro, 'read_only OFF con super_read_only ON'); n.ro = false; return [[]]; }
        if (/read_only = ON/.test(sql)) { n.ro = true; return [[]]; }
        if (/CHANGE REPLICATION SOURCE/.test(sql)) { assert(!n.sro, 'CHANGE con super_read_only'); n.fuente = p[0]; return [[]]; }
        if (/START REPLICA/.test(sql)) { n.io = 'ON'; return [[]]; }
        throw new Error('SQL no simulado: ' + sql);
      },
    };
  },
};

// ---------- PostgreSQL simulado ----------
const pg = {};
const nuevoPg = (lsn, standby, otro) => ({ up: true, standby, ro: 'off', lsn, otro, diverge: false });
function tickPg() {
  for (const n of Object.values(pg)) {
    const o = pg[n.otro];
    n.streaming = n.up && n.standby && !n.diverge && o && o.up && !o.standby;
    if (n.streaming) n.lsn = o.lsn;
  }
}
const hex = (x) => '0/' + x.toString(16).toUpperCase();
class ClientMock {
  constructor({ host }) { this.host = host; }
  async connect() { const n = pg[this.host]; if (!n || !n.up) throw Object.assign(new Error('ECONNREFUSED ' + this.host), { code: 'ECONNREFUSED' }); }
  async end() {}
  async query(sql) {
    const n = pg[this.host];
    if (/pg_is_in_recovery\(\) AS rec, current_setting/.test(sql)) return { rows: [{ rec: n.standby, ro: n.ro, aplicado: hex(n.lsn), recibido: n.standby ? hex(n.lsn) : null }] };
    if (/pg_stat_wal_receiver/.test(sql)) return { rows: n.standby && n.streaming ? [{ status: 'streaming', sender_host: n.otro }] : [] };
    if (/pg_last_wal_receive_lsn\(\)::text AS rec/.test(sql)) return { rows: [{ rec: hex(n.lsn), apl: hex(n.lsn) }] };
    if (/pg_promote/.test(sql)) { assert(n.standby, 'promover a un no-standby'); n.standby = false; return { rows: [{}] }; }
    if (/ALTER SYSTEM RESET default_transaction_read_only/.test(sql)) { n.ro = 'off'; return { rows: [] }; }
    if (/ALTER SYSTEM SET default_transaction_read_only = on/.test(sql)) { n.ro = 'on'; return { rows: [] }; }
    if (/pg_reload_conf|pg_terminate_backend/.test(sql)) return { rows: [] };
    throw new Error('SQL no simulado: ' + sql);
  }
}

const cargar = Module._load;
Module._load = function (req, ...r) {
  if (req === 'mysql2/promise') return mysqlMock;
  if (req === 'pg') return { Client: ClientMock };
  return cargar.call(this, req, ...r);
};
const ruta = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'vigilante.js'));
Module._resolveFilename = ((orig) => function (req, parent, ...r) {
  if (req === 'mysql2/promise' || req === 'pg') return req;
  return orig.call(this, req, parent, ...r);
})(Module._resolveFilename);
const v = require(ruta);
const M = v.motores.mysql, P = v.motores.postgres;
const ultimo = () => v.bitacora[0] && v.bitacora[0].mensaje;
let pasos = 0;
async function ciclos(n, fnMy = true, fnPg = true) {
  for (let i = 0; i < n; i++) { tickMy(); tickPg(); if (fnMy) await v.cicloMysql(M); if (fnPg) await v.cicloPg(P); tickMy(); tickPg(); pasos++; }
}
const ok = (t) => console.log('  ✔ ' + t);

(async () => {
  console.log('MySQL');
  // Estado de la etapa 2: db1 primario escribible, db2 réplica de db1
  my.db1 = nuevoMy(['a1', 'a2']); my.db1.ro = false; my.db1.sro = false;
  my.db2 = nuevoMy(['a1']); my.db2.fuente = 'db1'; my.db2.io = 'ON';
  await ciclos(3, true, false);
  assert.equal(M.primario, 'db1'); assert(my.db2.gtid.has('a2')); ok('estable: db1 primario, db2 al día');

  my.db1.gtid.add('a3'); await ciclos(1, true, false);
  my.db1.up = false;
  let n = 0; while (my.db2.ro && n < 20) { await ciclos(1, true, false); n++; }
  assert.equal(my.db2.ro, false); assert.equal(M.primario, 'db2'); assert.equal(my.db2.fuente, null);
  assert(n >= 5, 'promovió antes del umbral'); ok(`db1 cae → db2 promovido en el ciclo ${n} (umbral 5); "${ultimo()}"`);

  my.db2.gtid.add('b1');
  my.db1.up = true; my.db1.ro = true; my.db1.sro = true; my.db1.fuente = null; // vuelve en solo lectura (PERSIST)
  await ciclos(2, true, false);
  assert.equal(my.db1.fuente, 'db2'); assert(my.db1.ro && my.db1.sro); assert(my.db1.gtid.has('b1'));
  ok('db1 regresa en solo lectura → reenganchado como réplica de db2 y al día');

  my.db2.up = false; await ciclos(1, true, false); my.db2.up = true; my.db2.ro = true; my.db2.sro = true; // reinicio rápido
  await ciclos(1, true, false);
  assert.equal(M.primario, 'db2'); assert.equal(my.db2.ro, false); assert(my.db1.ro);
  ok('reinicio rápido del primario db2 → vuelve a ser primario, sin failover');

  my.db1.ro = false; my.db1.sro = false; // dos primarios
  await ciclos(1, true, false);
  assert(my.db1.ro && my.db1.sro && !my.db2.ro); ok(`dos primarios → db1 cercado; "${v.bitacora.find((b) => /FENCING/.test(b.mensaje)).mensaje}"`);

  my.db1.up = false; await ciclos(1, true, false);
  my.db1.gtid.add('x9'); my.db1.fuente = null; my.db1.up = true; // regresa con una transacción que db2 no tiene
  await ciclos(2, true, false);
  assert.equal(my.db1.fuente, null); assert(my.db1.ro); assert.equal(M.primario, 'db2');
  ok('db1 regresa divergente → NO se reengancha, queda en solo lectura con aviso');

  my.db2.up = false; my.db1.up = false; await ciclos(3, true, false);
  assert.equal(M.primario, 'db2'); ok('los dos caídos → no promueve a nadie');
  my.db1.up = true; my.db1.gtid = new Set(my.db2.gtid); my.db1.fuente = 'db2'; my.db1.io = 'ON';
  my.db2.up = true; my.db2.ro = true; my.db2.sro = true;    // reinicio de todo: ambos en solo lectura
  await ciclos(1, true, false);
  assert.equal(my.db2.ro, false); assert(my.db1.ro); ok('reinicio de todo → habilita al último primario conocido (db2)');

  console.log('PostgreSQL');
  // Tras la migración: los dos arrancan como standby
  pg.db2 = nuevoPg(100, true, 'db3'); pg.db3 = nuevoPg(100, true, 'db2');
  await ciclos(1, false, true);
  assert.equal(pg.db2.standby, false); assert.equal(P.primario, 'db2'); ok('arranque con los dos en standby → db2 promovido');
  await ciclos(2, false, true);
  assert(pg.db3.streaming); ok('db3 sigue a db2 por streaming');

  pg.db2.lsn = 150; await ciclos(1, false, true);
  pg.db2.up = false;
  n = 0; while (pg.db3.standby && n < 20) { await ciclos(1, false, true); n++; }
  assert.equal(pg.db3.standby, false); assert.equal(P.primario, 'db3'); assert(n >= 5);
  ok(`db2 cae → db3 promovido en el ciclo ${n}; "${ultimo()}"`);

  pg.db2.up = true; pg.db2.standby = true; // arranque.sh: vuelve como standby
  await ciclos(2, false, true);
  assert(pg.db2.standby && pg.db2.streaming); ok('db2 regresa como standby y sigue a db3 (sin split brain)');

  pg.db3.up = false; pg.db2.diverge = true; // el standby no seguía bien: no es elegible fuera del arranque
  v.CFG.seguiaVentanaMs = 0;                // simular que ya pasó el minuto de arranque
  await ciclos(8, false, true);
  ok(`db3 cae con db2 sin streaming → ${pg.db2.standby ? 'NO promueve un standby que no estaba al día' : 'promovió (arranque)'}`);

  pg.db3.up = true; pg.db2.standby = false; pg.db2.ro = 'off'; pg.db2.diverge = false;  // dos primarios
  await ciclos(1, false, true);
  const queda = P.primario; const otro = queda === 'db2' ? 'db3' : 'db2';
  assert.equal(pg[otro].ro, 'on'); ok(`dos primarios → ${otro} cercado (default_transaction_read_only), queda ${queda}`);

  console.log(`\nTodas las pruebas pasaron (${pasos} ciclos).`);
  process.exit(0);
})().catch((e) => { console.error('✘', e.message); console.error(v.bitacora.slice(0, 8)); process.exit(1); });
