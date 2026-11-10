// Vigilante de failover automático de MySQL y PostgreSQL (D25, D27). Corre UNA sola vez, en el rol app.
//
// Regla de oro contra el split brain: ningún nodo es primario por su cuenta.
//   - MySQL arranca siempre en solo lectura (super_read_only persistido). El vigilante lo habilita con
//     SET GLOBAL (no persistido), así que si el primario se reinicia, vuelve en solo lectura.
//   - PostgreSQL arranca siempre como standby (el contenedor crea standby.signal). El vigilante lo promueve.
//
// Cada CICLO_MS revisa todos los nodos:
//   - 1 primario  → todo bien; reengancha como réplica a los demás (MySQL) y vigila que sigan al día.
//   - 2 primarios → deja el oficial y pone al otro en solo lectura (fencing).
//   - 0 primarios → si todos responden, promueve ya; si falta alguno, espera UMBRAL ciclos. Promueve
//                   al último primario conocido si responde; si no, al respaldo más al día que lo seguía.
// Expone GET /estado (JSON) y GET /metrics (Prometheus) en el puerto 8090.
'use strict';
const http = require('http');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const client = require('prom-client');

const lista = (v, def) => (v || def).split(',').map((s) => s.trim()).filter(Boolean);
const CFG = {
  mysql: lista(process.env.MYSQL_HOSTS, 'db1,db2'),
  postgres: lista(process.env.PG_HOSTS, 'db2,db3'),
  cicloMs: Number(process.env.CICLO_MS || 2000),
  umbral: Number(process.env.UMBRAL || 5),          // ciclos sin primario antes de promover (~10 s)
  seguiaVentanaMs: 60000,                             // un respaldo es elegible si siguió al primario en este tiempo
  puerto: Number(process.env.PORT || 8090),
  archivoEstado: process.env.ARCHIVO_ESTADO || '/estado/vigilante.json',
};

// ---------- Estado, bitácora y métricas ----------
let persistido = {};
try { persistido = JSON.parse(fs.readFileSync(CFG.archivoEstado, 'utf8')); } catch (_) { /* primera vez */ }
const guardar = () => {
  try { fs.writeFileSync(CFG.archivoEstado, JSON.stringify(persistido)); } catch (e) { console.error('No pude guardar el estado:', e.message); }
};

const bitacora = [];
function anotar(motor, mensaje) {
  const linea = { fecha: new Date().toISOString(), motor, mensaje };
  bitacora.unshift(linea);
  bitacora.length = Math.min(bitacora.length, 100);
  console.log(`${linea.fecha} [${motor}] ${mensaje}`);
}

const registro = new client.Registry();
const gAlcanzable = new client.Gauge({ name: 'vigilante_nodo_alcanzable', help: '1 si el vigilante alcanza el nodo', labelNames: ['motor', 'nodo'], registers: [registro] });
const gPrimario = new client.Gauge({ name: 'vigilante_es_primario', help: '1 si el nodo es el primario', labelNames: ['motor', 'nodo'], registers: [registro] });
const gSinPrimario = new client.Gauge({ name: 'vigilante_sin_primario', help: '1 si el motor no tiene primario', labelNames: ['motor'], registers: [registro] });
const cFailovers = new client.Counter({ name: 'vigilante_failovers_total', help: 'Promociones hechas por el vigilante', labelNames: ['motor'], registers: [registro] });
const cRejoins = new client.Counter({ name: 'vigilante_rejoins_total', help: 'Nodos reenganchados como réplica', labelNames: ['motor'], registers: [registro] });
const cFencing = new client.Counter({ name: 'vigilante_fencing_total', help: 'Primarios sobrantes puestos en solo lectura', labelNames: ['motor'], registers: [registro] });

function nuevoMotor(nombre, hosts) {
  return {
    nombre, hosts,
    primario: persistido[nombre] || null, // último primario oficial
    sinPrimario: 0,                        // ciclos seguidos sin primario
    seguia: {},                            // nodo → última vez que replicaba del primario
    avisos: {},                            // para no repetir el mismo aviso cada ciclo
    nodos: {},
  };
}
const motores = { mysql: nuevoMotor('mysql', CFG.mysql), postgres: nuevoMotor('postgres', CFG.postgres) };

// Recién arrancado, el vigilante no sabe quién seguía a quién: en ese lapso cualquier respaldo vivo es elegible.
const ARRANQUE = Date.now();
const elegibleSegun = (m, h) => Date.now() - ARRANQUE < CFG.seguiaVentanaMs || Date.now() - (m.seguia[h] || 0) < CFG.seguiaVentanaMs;

function avisarCada(m, clave, ms, mensaje) {
  const ahora = Date.now();
  if (!m.avisos[clave] || ahora - m.avisos[clave] > ms) { m.avisos[clave] = ahora; anotar(m.nombre, mensaje); }
}
function fijarPrimario(m, host) {
  if (m.primario !== host) {
    m.primario = host;
    persistido[m.nombre] = host;
    guardar();
  }
}

// ======================= MySQL =======================
const conMysql = (host) => mysql.createConnection({
  host, port: 3306, user: 'failover_mysql', password: process.env.MYSQL_FAILOVER_PASSWORD, connectTimeout: 2000,
});

async function sondearMysql(host) {
  const cx = await conMysql(host);
  try {
    const [[v]] = await cx.query('SELECT @@global.read_only AS ro, @@global.gtid_executed AS gtid');
    const [conf] = await cx.query(`SELECT c.HOST AS fuente, s.SERVICE_STATE AS io, s.RECEIVED_TRANSACTION_SET AS recibido,
      s.LAST_ERROR_MESSAGE AS error_io FROM performance_schema.replication_connection_configuration c
      JOIN performance_schema.replication_connection_status s USING (CHANNEL_NAME)`);
    const [ap] = await cx.query('SELECT SERVICE_STATE AS sql_estado FROM performance_schema.replication_applier_status');
    return {
      alcanzable: true, escribible: Number(v.ro) === 0, gtid: (v.gtid || '').replace(/\n/g, ''),
      fuente: conf[0] ? conf[0].fuente : null, io: conf[0] ? conf[0].io : null, error_io: conf[0] ? conf[0].error_io : null,
      recibido: conf[0] ? (conf[0].recibido || '').replace(/\n/g, '') : '', sql: ap[0] ? ap[0].sql_estado : null,
    };
  } finally {
    await cx.end().catch(() => {});
  }
}

async function gtidSubconjunto(hostReferencia, gtid) {
  const cx = await conMysql(hostReferencia);
  try {
    const [[r]] = await cx.query('SELECT GTID_SUBSET(?, @@global.gtid_executed) AS ok', [gtid]);
    return Number(r.ok) === 1;
  } finally { await cx.end().catch(() => {}); }
}

async function promoverMysql(host, n) {
  const cx = await conMysql(host);
  try {
    if (n.fuente && n.recibido) {
      // Aplicar todo lo que ya había llegado del primario anterior antes de abrir escrituras
      await cx.query('SELECT WAIT_FOR_EXECUTED_GTID_SET(?, 10)', [n.recibido]);
    }
    await cx.query('STOP REPLICA');
    await cx.query('RESET REPLICA ALL');
    await cx.query('SET GLOBAL super_read_only = OFF');
    await cx.query('SET GLOBAL read_only = OFF'); // SET GLOBAL, no PERSIST: al reiniciarse vuelve en solo lectura
  } finally { await cx.end().catch(() => {}); }
}

async function reengancharMysql(host, primario) {
  const cx = await conMysql(host);
  try {
    await cx.query('SET GLOBAL read_only = ON');        // la app sigue sin poder escribir
    await cx.query('SET GLOBAL super_read_only = OFF'); // solo para poder reconfigurar la réplica
    await cx.query('STOP REPLICA');
    await cx.query(`CHANGE REPLICATION SOURCE TO SOURCE_HOST = ?, SOURCE_PORT = 3306, SOURCE_USER = 'repl_mysql',
      SOURCE_PASSWORD = ?, SOURCE_AUTO_POSITION = 1, SOURCE_SSL = 1, GET_SOURCE_PUBLIC_KEY = 1,
      SOURCE_CONNECT_RETRY = 10, SOURCE_RETRY_COUNT = 8640`, [primario, process.env.MYSQL_REPL_PASSWORD]);
    await cx.query('START REPLICA');
  } finally {
    await cx.query('SET GLOBAL super_read_only = ON').catch(() => {});
    await cx.end().catch(() => {});
  }
}

async function cercarMysql(host) {
  const cx = await conMysql(host);
  try { await cx.query('SET GLOBAL super_read_only = ON'); } finally { await cx.end().catch(() => {}); }
}

async function cicloMysql(m) {
  await Promise.all(m.hosts.map(async (h) => {
    try { m.nodos[h] = await sondearMysql(h); } catch (e) { m.nodos[h] = { alcanzable: false, error: e.message }; }
  }));
  const vivos = m.hosts.filter((h) => m.nodos[h].alcanzable);
  let escribibles = vivos.filter((h) => m.nodos[h].escribible);

  // Dos primarios: queda el oficial (o el primero de la lista) y el otro pasa a solo lectura
  if (escribibles.length > 1) {
    const queda = escribibles.includes(m.primario) ? m.primario : escribibles[0];
    for (const h of escribibles.filter((x) => x !== queda)) {
      await cercarMysql(h);
      cFencing.inc({ motor: 'mysql' });
      anotar('mysql', `FENCING: ${h} también aceptaba escrituras; queda en solo lectura (primario: ${queda})`);
    }
    escribibles = [queda];
  }

  if (escribibles.length === 1) {
    const p = escribibles[0];
    if (m.primario !== p) anotar('mysql', `primario: ${p}`);
    fijarPrimario(m, p);
    m.sinPrimario = 0;
    for (const h of vivos.filter((x) => x !== p)) {
      const n = m.nodos[h];
      if (n.fuente === p && n.io !== 'OFF') { m.seguia[h] = Date.now(); continue; }
      if (n.fuente === p && n.io === 'OFF') {
        avisarCada(m, 'start-' + h, 60000, `${h}: la réplica estaba detenida (${n.error_io || 'sin error'}); la arranco`);
        const cx = await conMysql(h);
        await cx.query('START REPLICA').finally(() => cx.end().catch(() => {}));
        continue;
      }
      // Sigue a otro nodo o a ninguno (por ejemplo, el viejo primario que regresó): ¿se puede reenganchar?
      if (await gtidSubconjunto(p, n.gtid)) {
        await reengancharMysql(h, p);
        cRejoins.inc({ motor: 'mysql' });
        anotar('mysql', `REJOIN: ${h} vuelve como réplica de ${p}`);
      } else {
        avisarCada(m, 'div-' + h, 60000, `${h} tiene transacciones que ${p} no tiene: no se reengancha solo. Corre en ${h}: bash scripts/mysql/rejoin.sh ${p} --reconstruir`);
      }
    }
    return;
  }

  // Sin primario
  const faltan = m.hosts.length - vivos.length;
  m.sinPrimario++;
  if (vivos.length === 0) { avisarCada(m, 'nadie', 15000, 'ningún nodo responde'); return; }
  if (faltan > 0 && m.sinPrimario < CFG.umbral) {
    avisarCada(m, 'espera', 15000, `sin primario (${m.primario || '?'} no responde); espero ${CFG.umbral} ciclos antes de promover`);
    return;
  }
  const candidato = await elegirMysql(m, vivos);
  if (!candidato) { avisarCada(m, 'sin-cand', 15000, 'sin primario y sin un respaldo sano para promover'); return; }
  const anterior = m.primario;
  await promoverMysql(candidato, m.nodos[candidato]);
  fijarPrimario(m, candidato);
  m.sinPrimario = 0;
  if (anterior && anterior !== candidato) cFailovers.inc({ motor: 'mysql' });
  anotar('mysql', anterior && anterior !== candidato
    ? `FAILOVER: ${anterior} no responde → ${candidato} promovido a primario`
    : `${candidato} habilitado como primario`);
}

async function elegirMysql(m, vivos) {
  // 1. El último primario oficial, si responde (por ejemplo, tras reiniciar todo)
  if (m.primario && vivos.includes(m.primario)) return m.primario;
  // 2. Respaldos elegibles: si se conocía un primario, solo los que lo seguían hace poco
  const elegibles = m.primario ? vivos.filter((h) => elegibleSegun(m, h)) : vivos;
  if (!elegibles.length) return null;
  // 3. El que tenga todas las transacciones de los demás (GTID superconjunto); empate → orden de la lista
  for (const h of elegibles) {
    let contieneATodos = true;
    for (const o of vivos.filter((x) => x !== h)) {
      if (!(await gtidSubconjunto(h, m.nodos[o].gtid))) { contieneATodos = false; break; }
    }
    if (contieneATodos) return h;
  }
  return elegibles[0];
}

// ======================= PostgreSQL =======================
async function conPg(host, fn) {
  const cx = new Client({
    host, port: 5432, user: 'failover_pg', password: process.env.PG_FAILOVER_PASSWORD, database: 'ecommerce',
    connectionTimeoutMillis: 2000, statement_timeout: 40000,
  });
  await cx.connect();
  try { return await fn(cx); } finally { await cx.end().catch(() => {}); }
}

// LSN "16/B374D848" → BigInt, para comparar qué nodo está más adelante
const lsn = (s) => { if (!s) return 0n; const [a, b] = s.split('/'); return (BigInt('0x' + a) << 32n) + BigInt('0x' + b); };

async function sondearPg(host) {
  return conPg(host, async (cx) => {
    const r = (await cx.query(`SELECT pg_is_in_recovery() AS rec, current_setting('default_transaction_read_only') AS ro,
      CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END::text AS aplicado,
      pg_last_wal_receive_lsn()::text AS recibido`)).rows[0];
    const w = (await cx.query('SELECT status, sender_host FROM pg_stat_wal_receiver')).rows[0];
    return {
      alcanzable: true, standby: r.rec, escribible: !r.rec && r.ro === 'off', cercado: !r.rec && r.ro === 'on',
      aplicado: r.aplicado, recibido: r.recibido, streaming: !!(w && w.status === 'streaming'), fuente: w ? w.sender_host : null,
    };
  });
}

async function promoverPg(host) {
  await conPg(host, async (cx) => {
    // Esperar a que aplique lo recibido (máximo 10 s)
    for (let i = 0; i < 20; i++) {
      const r = (await cx.query('SELECT pg_last_wal_receive_lsn()::text AS rec, pg_last_wal_replay_lsn()::text AS apl')).rows[0];
      if (!r.rec || lsn(r.apl) >= lsn(r.rec)) break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    await cx.query('SELECT pg_promote(true, 30)');
    await cx.query('ALTER SYSTEM RESET default_transaction_read_only');
    await cx.query('SELECT pg_reload_conf()');
  });
}

async function cercarPg(host) {
  await conPg(host, async (cx) => {
    await cx.query('ALTER SYSTEM SET default_transaction_read_only = on');
    await cx.query('SELECT pg_reload_conf()');
    await cx.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'app_ecommerce'");
  });
}

async function cicloPg(m) {
  await Promise.all(m.hosts.map(async (h) => {
    try { m.nodos[h] = await sondearPg(h); } catch (e) { m.nodos[h] = { alcanzable: false, error: e.message }; }
  }));
  const vivos = m.hosts.filter((h) => m.nodos[h].alcanzable);
  let escribibles = vivos.filter((h) => m.nodos[h].escribible);

  if (escribibles.length > 1) {
    const queda = escribibles.includes(m.primario) ? m.primario : escribibles[0];
    for (const h of escribibles.filter((x) => x !== queda)) {
      await cercarPg(h);
      cFencing.inc({ motor: 'postgres' });
      anotar('postgres', `FENCING: ${h} también era primario; queda en solo lectura. Para reengancharlo, en ${h}: bash scripts/postgres/rejoin.sh ${queda}`);
    }
    escribibles = [queda];
  }

  if (escribibles.length === 1) {
    const p = escribibles[0];
    if (m.primario !== p) anotar('postgres', `primario: ${p}`);
    fijarPrimario(m, p);
    m.sinPrimario = 0;
    for (const h of vivos.filter((x) => x !== p)) {
      const n = m.nodos[h];
      if (n.standby && n.streaming && n.fuente === p) { m.seguia[h] = Date.now(); continue; }
      if (n.cercado) {
        avisarCada(m, 'cerc-' + h, 60000, `${h} quedó como primario sobrante (cercado). En ${h}: bash scripts/postgres/rejoin.sh ${p}`);
      } else if (Date.now() - (m.seguia[h] || 0) > 30000) {
        // El standby debería conectarse solo al primario en pocos segundos; si no, divergió
        avisarCada(m, 'div-' + h, 60000, `${h} no está recibiendo WAL de ${p}. Si no se arregla solo, en ${h}: bash scripts/postgres/rejoin.sh ${p}`);
      }
    }
    return;
  }

  const faltan = m.hosts.length - vivos.length;
  m.sinPrimario++;
  if (vivos.length === 0) { avisarCada(m, 'nadie', 15000, 'ningún nodo responde'); return; }
  if (faltan > 0 && m.sinPrimario < CFG.umbral) {
    avisarCada(m, 'espera', 15000, `sin primario (${m.primario || '?'} no responde); espero ${CFG.umbral} ciclos antes de promover`);
    return;
  }
  const candidato = elegirPg(m, vivos);
  if (!candidato) { avisarCada(m, 'sin-cand', 15000, 'sin primario y sin un standby sano para promover'); return; }
  const anterior = m.primario;
  await promoverPg(candidato);
  fijarPrimario(m, candidato);
  m.sinPrimario = 0;
  if (anterior && anterior !== candidato) cFailovers.inc({ motor: 'postgres' });
  anotar('postgres', anterior && anterior !== candidato
    ? `FAILOVER: ${anterior} no responde → ${candidato} promovido a primario`
    : `${candidato} promovido a primario`);
}

function elegirPg(m, vivos) {
  const candidatos = vivos.filter((h) => m.nodos[h].standby);
  if (m.primario && candidatos.includes(m.primario)) return m.primario;
  const elegibles = m.primario ? candidatos.filter((h) => elegibleSegun(m, h)) : candidatos;
  if (!elegibles.length) return null;
  // El más adelantado (mayor LSN); empate → orden de la lista
  return elegibles.reduce((mejor, h) => (lsn(m.nodos[h].recibido || m.nodos[h].aplicado) > lsn(m.nodos[mejor].recibido || m.nodos[mejor].aplicado) ? h : mejor));
}

// ======================= Bucle y HTTP =======================
function publicarMetricas() {
  for (const m of Object.values(motores)) {
    for (const h of m.hosts) {
      const n = m.nodos[h] || {};
      gAlcanzable.set({ motor: m.nombre, nodo: h }, n.alcanzable ? 1 : 0);
      gPrimario.set({ motor: m.nombre, nodo: h }, n.alcanzable && n.escribible ? 1 : 0);
    }
    gSinPrimario.set({ motor: m.nombre }, m.hosts.some((h) => m.nodos[h] && m.nodos[h].alcanzable && m.nodos[h].escribible) ? 0 : 1);
  }
}

async function bucle(m, ciclo) {
  for (;;) {
    const inicio = Date.now();
    try { await ciclo(m); } catch (e) { avisarCada(m, 'err:' + e.message, 30000, `error en el ciclo: ${e.message}`); }
    publicarMetricas();
    await new Promise((ok) => setTimeout(ok, Math.max(200, CFG.cicloMs - (Date.now() - inicio))));
  }
}

// Al cargarse desde una prueba (require) no arranca el servidor ni los bucles.
if (require.main !== module) {
  module.exports = { motores, cicloMysql, cicloPg, bitacora, CFG };
  return;
}

http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', registro.contentType);
    return res.end(await registro.metrics());
  }
  if (req.url === '/estado' || req.url === '/') {
    const estado = {};
    for (const m of Object.values(motores)) {
      estado[m.nombre] = {
        primario: m.primario, sin_primario_ciclos: m.sinPrimario,
        nodos: Object.fromEntries(m.hosts.map((h) => {
          const n = m.nodos[h] || {};
          const rol = !n.alcanzable ? 'CAÍDO' : n.escribible ? 'PRIMARIO' : n.cercado ? 'CERCADO' : 'RÉPLICA';
          return [h, { rol, ...(n.fuente !== undefined ? { sigue_a: n.fuente } : {}), ...(n.error ? { error: n.error } : {}) }];
        })),
      };
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ...estado, bitacora: bitacora.slice(0, 20) }, null, 2));
  }
  res.statusCode = 404;
  res.end('GET /estado o /metrics\n');
}).listen(CFG.puerto, () => {
  anotar('vigilante', `escuchando en :${CFG.puerto}  mysql=${CFG.mysql}  postgres=${CFG.postgres}  ciclo=${CFG.cicloMs} ms  umbral=${CFG.umbral}`);
  bucle(motores.mysql, cicloMysql);
  bucle(motores.postgres, cicloPg);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
