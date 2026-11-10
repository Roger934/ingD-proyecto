// Conexiones a los 3 motores, tolerantes a fallas (F7).
//  - MySQL: lista de hosts (db1,db2). Se usa el que NO esté en read_only. Si se cae, se vuelve a buscar.
//  - PostgreSQL: lista de hosts (db2,db3). Se usa el que NO esté en recuperación (equivale a target_session_attrs=read-write).
//  - MongoDB: el driver recibe los dos mongos (db3, app) y cambia solo de uno a otro.
// Las bases NO se conectan entre sí: solo la API habla con cada una.
'use strict';
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

const lista = (v, def) => (v || def).split(',').map((s) => s.trim()).filter(Boolean);
const CFG = {
  mysqlHosts: lista(process.env.MYSQL_HOSTS, 'db1,db2'),
  pgHosts: lista(process.env.PG_HOSTS, 'db2,db3'),
  mongoHosts: lista(process.env.MONGO_HOSTS, 'db3:27017,app:27017'),
};

class ErrorMotor extends Error {
  constructor(motor, mensaje, causa) {
    super(mensaje);
    this.motor = motor;
    this.causa = causa;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Selección de primario genérica ----------
// crear(host) → recurso; esPrimario(recurso) → bool; cerrar(recurso)
function selectorPrimario(motor, hosts, crear, esPrimario, cerrar) {
  let actual = null;      // { host, recurso }
  let buscando = null;    // promesa compartida para no buscar en paralelo

  async function buscar() {
    for (const host of hosts) {
      const recurso = crear(host);
      try {
        if (await esPrimario(recurso)) {
          actual = { host, recurso };
          console.log(`[${motor}] primario: ${host}`);
          return actual;
        }
      } catch (_) { /* host caído: probar el siguiente */ }
      await cerrar(recurso).catch(() => {});
    }
    throw new ErrorMotor(motor, `No hay un primario de ${motor} disponible (${hosts.join(', ')})`);
  }

  return {
    async obtener() {
      if (actual) return actual;
      if (!buscando) buscando = buscar().finally(() => { buscando = null; });
      return buscando;
    },
    olvidar(recurso) {
      if (actual && (!recurso || actual.recurso === recurso)) {
        console.warn(`[${motor}] se pierde el primario ${actual.host}; se buscará de nuevo`);
        const viejo = actual.recurso;
        actual = null;
        cerrar(viejo).catch(() => {});
      }
    },
    host: () => (actual ? actual.host : null),
  };
}

// ---------- MySQL ----------
const ERR_MYSQL_REINTENTABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE',
  'PROTOCOL_CONNECTION_LOST', 'ER_OPTION_PREVENTS_STATEMENT', 'ER_SERVER_SHUTDOWN', 'ER_CON_COUNT_ERROR']);

const mysqlSel = selectorPrimario('mysql', CFG.mysqlHosts,
  (host) => mysql.createPool({
    host, port: 3306, user: 'app_ecommerce', password: process.env.MYSQL_APP_PASSWORD, database: 'ecommerce',
    connectionLimit: 15, connectTimeout: 3000, decimalNumbers: true, dateStrings: true, timezone: 'Z',
  }),
  async (pool) => { const [[r]] = await pool.query('SELECT @@global.read_only AS ro'); return Number(r.ro) === 0; },
  (pool) => pool.end());

// ---------- PostgreSQL ----------
const ERR_PG_REINTENTABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE',
  '25006' /* read_only_sql_transaction */, '57P01' /* admin_shutdown */, '57P02', '57P03' /* cannot_connect_now */, '08006', '08001', '08003']);

const pgSel = selectorPrimario('postgres', CFG.pgHosts,
  (host) => {
    const pool = new Pool({
      host, port: 5432, user: 'app_ecommerce', password: process.env.PG_APP_PASSWORD, database: 'ecommerce',
      max: 15, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000,
    });
    pool.on('error', () => pgSel.olvidar(pool)); // un cliente inactivo perdió la conexión
    return pool;
  },
  async (pool) => { const r = await pool.query('SELECT pg_is_in_recovery() AS rec'); return r.rows[0].rec === false; },
  (pool) => pool.end());

// Los errores de pg traen "code"; los de conexión a veces vienen sin code y con este mensaje.
const pgPerdida = (e) => ERR_PG_REINTENTABLE.has(e.code) || /terminat|Connection terminated|timeout/i.test(e.message || '');
const mysqlPerdida = (e) => ERR_MYSQL_REINTENTABLE.has(e.code) || e.fatal === true;

// conReintento(selector, esPerdida, fn): corre fn(recurso). Si el error es de conexión o de
// "solo lectura" (el primario cambió), olvida el primario, espera y reintenta (3 intentos con backoff).
// Las funciones que se pasan aquí deben ser idempotentes (la Saga lo cuida).
async function conReintento(motor, selector, esPerdida, fn) {
  let ultimo;
  for (let intento = 0; intento < 3; intento++) {
    let actual;
    try {
      actual = await selector.obtener();
      return await fn(actual.recurso);
    } catch (e) {
      ultimo = e;
      if (e instanceof ErrorMotor || esPerdida(e)) {
        if (actual) selector.olvidar(actual.recurso);
        await esperar(300 * 2 ** intento);
        continue;
      }
      throw e; // error de datos o de negocio: no se reintenta
    }
  }
  throw ultimo instanceof ErrorMotor ? ultimo : new ErrorMotor(motor, `${motor} no disponible: ${ultimo.message}`, ultimo);
}

const conMysql = (fn) => conReintento('mysql', mysqlSel, mysqlPerdida, fn);
const conPg = (fn) => conReintento('postgres', pgSel, pgPerdida, fn);

// Transacciones
async function txMysql(fn) {
  return conMysql(async (pool) => {
    const cx = await pool.getConnection();
    try {
      await cx.beginTransaction();
      const r = await fn(cx);
      await cx.commit();
      return r;
    } catch (e) {
      await cx.rollback().catch(() => {});
      throw e;
    } finally {
      cx.release();
    }
  });
}

async function txPg(fn) {
  return conPg(async (pool) => {
    const cx = await pool.connect();
    let roto = false;
    try {
      await cx.query('BEGIN');
      const r = await fn(cx);
      await cx.query('COMMIT');
      return r;
    } catch (e) {
      roto = pgPerdida(e);
      await cx.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      cx.release(roto);
    }
  });
}

// ---------- MongoDB ----------
const mongoUri = `mongodb://app_ecommerce:${encodeURIComponent(process.env.MONGO_APP_PASSWORD || '')}@${CFG.mongoHosts.join(',')}` +
  '/ecommerce?authSource=admin&serverSelectionTimeoutMS=4000&connectTimeoutMS=3000&retryWrites=true';
const mongoCliente = new MongoClient(mongoUri, { maxPoolSize: 20, appName: 'ingdatos-api' });
let mongoListo = null;
async function mongo() {
  if (!mongoListo) mongoListo = mongoCliente.connect().catch((e) => { mongoListo = null; throw e; });
  try {
    await mongoListo;
  } catch (e) {
    throw new ErrorMotor('mongo', `MongoDB no disponible: ${e.message}`, e);
  }
  return mongoCliente.db('ecommerce');
}

// Envuelve operaciones de Mongo para que sus fallas lleguen como ErrorMotor('mongo').
async function conMongo(fn) {
  const db = await mongo();
  try {
    return await fn(db);
  } catch (e) {
    if (e.name && /^Mongo/.test(e.name)) throw new ErrorMotor('mongo', `MongoDB: ${e.message}`, e);
    throw e;
  }
}

// ---------- Salud ----------
async function salud() {
  const probar = async (fn) => {
    const t = Date.now();
    try { const detalle = await fn(); return { ok: true, ms: Date.now() - t, ...detalle }; }
    catch (e) { return { ok: false, ms: Date.now() - t, error: e.message }; }
  };
  const [m, p, g] = await Promise.all([
    probar(() => conMysql(async (pool) => { await pool.query('SELECT 1'); return { primario: mysqlSel.host() }; })),
    probar(() => conPg(async (pool) => { await pool.query('SELECT 1'); return { primario: pgSel.host() }; })),
    probar(() => conMongo(async (db) => { await db.command({ ping: 1 }); return { mongos: CFG.mongoHosts }; })),
  ]);
  return { mysql: m, postgres: p, mongo: g };
}

async function cerrar() {
  mysqlSel.olvidar();
  pgSel.olvidar();
  await mongoCliente.close().catch(() => {});
}

module.exports = { CFG, ErrorMotor, conMysql, conPg, txMysql, txPg, conMongo, salud, cerrar, hosts: { mysql: () => mysqlSel.host(), postgres: () => pgSel.host() } };
