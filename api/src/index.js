// API del e-commerce: única pieza que habla con MySQL, PostgreSQL y MongoDB.
'use strict';
const express = require('express');
const db = require('./db');
const { comprar, ErrorCompra } = require('./saga');
const { registro } = require('./metricas');

const app = express();
app.use(express.json({ limit: '100kb' }));
const PUERTO = Number(process.env.PORT || 8080);

// Express 4 no atrapa errores de funciones async: este envoltorio los manda al manejador de errores.
const ruta = (fn) => (req, res, next) => fn(req, res).catch(next);
const idValido = (v) => /^\d{1,12}$/.test(String(v));

app.get('/salud', ruta(async (req, res) => {
  const s = await db.salud();
  const ok = s.mysql.ok && s.postgres.ok && s.mongo.ok;
  res.status(ok ? 200 : 503).json({ ok, ...s });
}));

app.get('/metrics', ruta(async (req, res) => {
  res.set('Content-Type', registro.contentType);
  res.send(await registro.metrics());
}));

// Proceso de negocio. Body: { cliente_id, sucursal_id, items?: [{ producto_id, cantidad }], resena?: { calificacion, comentario }, clave? }
// Sin items, se compra lo que haya en el carrito del cliente (Mongo).
app.post('/compras', ruta(async (req, res) => {
  const r = await comprar(req.body, req.get('Idempotency-Key'));
  res.status(r.repetida ? 200 : 201).json(r);
}));

// IDs de los últimos pedidos (MySQL primario). ?ultimos=N, de 1 a 50 (5 si no se indica). Lo usa scripts/ultimos.sh.
app.get('/pedidos', ruta(async (req, res) => {
  const n = Math.min(Math.max(Number.parseInt(req.query.ultimos, 10) || 5, 1), 50);
  const ids = await db.conMysql(async (pool) => {
    const [filas] = await pool.query('SELECT id FROM pedidos ORDER BY id DESC LIMIT ?', [n]);
    return filas.map((f) => f.id);
  });
  res.json({ ids });
}));

// Pedido reconstruido desde los 3 motores (para la demo y para revisar la consistencia).
app.get('/pedidos/:id', ruta(async (req, res) => {
  if (!idValido(req.params.id)) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'id inválido');
  const id = Number(req.params.id);
  const pedido = await db.conMysql(async (pool) => {
    // pedido_completo = pedidos ⋈ pedido_cliente (reconstrucción de la fragmentación vertical)
    const [[p]] = await pool.query('SELECT * FROM pedido_completo WHERE id = ?', [id]);
    if (!p) return null;
    const [detalle] = await pool.query('SELECT producto_id, cantidad, precio_unitario FROM detalle_pedido WHERE pedido_id = ? ORDER BY producto_id', [id]);
    return { ...p, detalle };
  });
  if (!pedido) throw new ErrorCompra(404, 'PEDIDO_NO_EXISTE', `No existe el pedido ${id}`);
  const [reservas, eventos] = await Promise.all([
    db.conPg(async (pool) => (await pool.query(
      'SELECT producto_id, sucursal_id, cantidad, estado, creado FROM reservas WHERE pedido_id = $1 ORDER BY producto_id', [id])).rows)
      .catch((e) => ({ error: e.message })),
    db.conMongo((m) => m.collection('eventos').find({ pedido_id: id }, { projection: { _id: 0, pedido_id: 0 } }).sort({ fecha: 1 }).toArray())
      .catch((e) => ({ error: e.message })),
  ]);
  res.json({ mysql: pedido, postgres: { reservas }, mongo: { eventos } });
}));

// Inventario de una sucursal (solo lee su fragmento). ?producto_id=1,2,3 o los 20 con menos existencias.
app.get('/inventario/:sucursal', ruta(async (req, res) => {
  if (!idValido(req.params.sucursal)) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'sucursal inválida');
  const sucursal = Number(req.params.sucursal);
  const ids = String(req.query.producto_id || '').split(',').filter(idValido).map(Number).slice(0, 100);
  const filas = await db.conPg(async (pool) => (ids.length
    ? await pool.query('SELECT producto_id, cantidad, actualizado FROM inventario WHERE sucursal_id = $1 AND producto_id = ANY($2::int[]) ORDER BY producto_id', [sucursal, ids])
    : await pool.query('SELECT producto_id, cantidad, actualizado FROM inventario WHERE sucursal_id = $1 ORDER BY cantidad, producto_id LIMIT 20', [sucursal])).rows);
  res.json({ sucursal_id: sucursal, fragmento: `inventario_s${sucursal}`, productos: filas });
}));

// Llenar o reemplazar el carrito de un cliente (Mongo). Body: { sucursal_id, items: [{ producto_id, cantidad }] }
// Lo usan probar-compra.sh y el simulador para el flujo "agregar al carrito → comprar".
app.put('/carritos/:cliente', ruta(async (req, res) => {
  if (!idValido(req.params.cliente)) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'cliente inválido');
  const b = req.body || {};
  const entero = (v, max) => Number.isInteger(v) && v >= 1 && v <= max;
  if (!entero(b.sucursal_id, 32767) || !Array.isArray(b.items) || b.items.length < 1 || b.items.length > 20
      || !b.items.every((i) => i && entero(i.producto_id, 2 ** 31 - 1) && entero(i.cantidad, 1000))) {
    throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'Se necesita sucursal_id e items (1 a 20) con producto_id y cantidad');
  }
  const doc = { cliente_id: Number(req.params.cliente), sucursal_id: b.sucursal_id,
    items: b.items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad })), actualizado: new Date() };
  await db.conMongo((m) => m.collection('carritos').updateOne({ cliente_id: doc.cliente_id }, { $set: doc }, { upsert: true }));
  res.json(doc);
}));

// Producto del catálogo (Mongo).
app.get('/productos/:id', ruta(async (req, res) => {
  if (!idValido(req.params.id)) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'id inválido');
  const p = await db.conMongo((m) => m.collection('catalogo').findOne({ producto_id: Number(req.params.id) }, { projection: { _id: 0 } }));
  if (!p) throw new ErrorCompra(404, 'PRODUCTO_NO_EXISTE', `No existe el producto ${req.params.id}`);
  res.json(p);
}));

app.use((req, res) => res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: `${req.method} ${req.path} no existe` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON_INVALIDO', mensaje: 'El body no es JSON válido' });
  if (err instanceof ErrorCompra) return res.status(err.status).json({ error: err.codigo, mensaje: err.message, ...err.extra });
  if (err instanceof db.ErrorMotor) return res.status(503).json({ error: 'MOTOR_NO_DISPONIBLE', motor: err.motor, mensaje: err.message });
  console.error(err);
  res.status(500).json({ error: 'ERROR_INTERNO', mensaje: err.message });
});

const servidor = app.listen(PUERTO, () => {
  console.log(`API escuchando en :${PUERTO}  mysql=${db.CFG.mysqlHosts}  postgres=${db.CFG.pgHosts}  mongos=${db.CFG.mongoHosts}`);
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    console.log(`${senal}: cerrando`);
    servidor.close(() => db.cerrar().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
