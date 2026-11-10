// Proceso de negocio: COMPRA, con patrón Saga (D6). Toca las 15 tablas/colecciones.
//
//  Paso | Motor      | Acción                                                         | Si falla
//  1    | Mongo      | leer carritos y catalogo, registrar logs_busqueda              | abortar
//  2    | PostgreSQL | leer sucursales y productos_sucursal (precio local) — solo lectura | abortar
//  3    | MySQL      | leer clientes/direcciones; crear pedidos (PENDIENTE), pedido_cliente, detalle_pedido | abortar
//  4    | PostgreSQL | descontar inventario, crear reservas y movimientos (SALIDA)    | compensar: liberar (si algo quedó) y pedido → CANCELADO
//  5    | MySQL      | pedido → CONFIRMADO                                             | compensar: liberar reserva (LIBERACION) y pedido → CANCELADO
//  6    | Mongo      | eventos (bitácora), vaciar carritos, resenas opcional          | reintentar (idempotente); no se compensa
//
// Idempotencia: cada compra lleva una clave (header Idempotency-Key o body.clave). Si se repite,
// se devuelve el pedido existente; si quedó PENDIENTE (la API se cayó a la mitad), la Saga continúa
// desde el paso 4, que es idempotente.
'use strict';
const { randomUUID } = require('crypto');
const { conMysql, conPg, txMysql, txPg, conMongo, ErrorMotor } = require('./db');
const m = require('./metricas');

class ErrorCompra extends Error {
  constructor(status, codigo, mensaje, extra = {}) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.extra = extra;
  }
}

const entero = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validar(body, claveHeader) {
  const b = body || {};
  const clave = String(claveHeader || b.clave || randomUUID());
  if (clave.length > 36) throw new ErrorCompra(400, 'CLAVE_INVALIDA', 'La clave de idempotencia admite máximo 36 caracteres');
  if (!entero(b.cliente_id, 1, 2 ** 31 - 1)) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'cliente_id debe ser un entero positivo');
  if (!entero(b.sucursal_id, 1, 32767)) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'sucursal_id debe ser un entero positivo');
  let items = null;
  if (b.items !== undefined) {
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 20) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'items debe tener de 1 a 20 elementos');
    items = b.items.map((it) => {
      if (!it || !entero(it.producto_id, 1, 2 ** 31 - 1) || !entero(it.cantidad, 1, 1000)) {
        throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'Cada item necesita producto_id (entero) y cantidad (1 a 1000)');
      }
      return { producto_id: it.producto_id, cantidad: it.cantidad };
    });
  }
  let resena = null;
  if (b.resena) {
    if (!entero(b.resena.calificacion, 1, 5)) throw new ErrorCompra(400, 'DATOS_INVALIDOS', 'resena.calificacion va de 1 a 5');
    resena = { calificacion: b.resena.calificacion, comentario: String(b.resena.comentario || '').slice(0, 500) };
  }
  return { clave, cliente_id: b.cliente_id, sucursal_id: b.sucursal_id, items, resena };
}

// Junta productos repetidos y ordena por producto_id (orden fijo = sin interbloqueos en PostgreSQL).
function normalizar(items) {
  const suma = new Map();
  for (const it of items) suma.set(it.producto_id, (suma.get(it.producto_id) || 0) + it.cantidad);
  return [...suma].map(([producto_id, cantidad]) => ({ producto_id, cantidad })).sort((a, b) => a.producto_id - b.producto_id);
}

// ---------- Paso 4 y su compensación (PostgreSQL) ----------
async function reservarInventario(pedidoId, sucursalId, items) {
  return txPg(async (cx) => {
    const ya = await cx.query("SELECT count(*)::int AS n FROM reservas WHERE pedido_id = $1 AND estado = 'ACTIVA'", [pedidoId]);
    if (ya.rows[0].n > 0) return { repetida: true }; // reintento: ya se había reservado
    for (const it of items) {
      // WHERE sucursal_id = $2 → PostgreSQL solo toca el fragmento de esa sucursal (partition pruning)
      const r = await cx.query(
        `UPDATE inventario SET cantidad = cantidad - $3, actualizado = now()
         WHERE producto_id = $1 AND sucursal_id = $2 AND cantidad >= $3 RETURNING cantidad`,
        [it.producto_id, sucursalId, it.cantidad]);
      if (r.rowCount === 0) {
        throw new ErrorCompra(409, 'STOCK_INSUFICIENTE', `No hay ${it.cantidad} unidades del producto ${it.producto_id} en la sucursal ${sucursalId}`,
          { producto_id: it.producto_id });
      }
      await cx.query('INSERT INTO reservas (pedido_id, producto_id, sucursal_id, cantidad) VALUES ($1, $2, $3, $4)',
        [pedidoId, it.producto_id, sucursalId, it.cantidad]);
      await cx.query("INSERT INTO movimientos (sucursal_id, producto_id, tipo, cantidad, pedido_id) VALUES ($1, $2, 'SALIDA', $3, $4)",
        [sucursalId, it.producto_id, it.cantidad, pedidoId]);
    }
    return { repetida: false };
  });
}

// Compensación: devuelve al inventario lo reservado por el pedido. Idempotente (solo toca reservas ACTIVA).
async function liberarReservas(pedidoId) {
  return txPg(async (cx) => {
    const r = await cx.query(
      "UPDATE reservas SET estado = 'LIBERADA' WHERE pedido_id = $1 AND estado = 'ACTIVA' RETURNING producto_id, sucursal_id, cantidad",
      [pedidoId]);
    for (const x of r.rows.sort((a, b) => a.producto_id - b.producto_id)) {
      await cx.query('UPDATE inventario SET cantidad = cantidad + $3, actualizado = now() WHERE producto_id = $1 AND sucursal_id = $2',
        [x.producto_id, x.sucursal_id, x.cantidad]);
      await cx.query("INSERT INTO movimientos (sucursal_id, producto_id, tipo, cantidad, pedido_id) VALUES ($1, $2, 'LIBERACION', $3, $4)",
        [x.sucursal_id, x.producto_id, x.cantidad, pedidoId]);
    }
    return r.rowCount;
  });
}

// Compensación en MySQL: solo cancela si sigue PENDIENTE.
async function cancelarPedido(pedidoId) {
  return conMysql(async (pool) => {
    const [r] = await pool.query("UPDATE pedidos SET estado = 'CANCELADO' WHERE id = ? AND estado = 'PENDIENTE'", [pedidoId]);
    return r.affectedRows;
  });
}

async function compensar(tipo, fn, eventos, evento) {
  try {
    await fn();
    m.compensaciones.inc({ tipo, resultado: 'ok' });
    eventos.push(evento);
    return true;
  } catch (e) {
    m.compensaciones.inc({ tipo, resultado: 'fallida' });
    console.error(`[saga] compensación ${tipo} fallida:`, e.message);
    eventos.push({ ...evento, tipo: evento.tipo + '_FALLIDA', detalle: { ...evento.detalle, error: e.message } });
    return false;
  }
}

// ---------- Paso 6 (Mongo): eventos con upsert por clave_evento → reintentos sin duplicados ----------
async function guardarEventos(pedidoId, eventos) {
  if (!eventos.length) return true;
  const ops = eventos.map((ev) => {
    const doc = { fecha: new Date(), ...ev, pedido_id: pedidoId, clave_evento: `${pedidoId}:${ev.tipo}`, origen: 'api' };
    // El filtro incluye pedido_id (la shard key): mongos manda la escritura a un solo shard.
    return { updateOne: { filter: { pedido_id: pedidoId, clave_evento: doc.clave_evento }, update: { $setOnInsert: doc }, upsert: true } };
  });
  for (let intento = 0; intento < 3; intento++) {
    try {
      await conMongo((db) => db.collection('eventos').bulkWrite(ops, { ordered: false }));
      return true;
    } catch (e) {
      console.warn(`[saga] eventos del pedido ${pedidoId}, intento ${intento + 1}:`, e.message);
      await new Promise((r) => setTimeout(r, 300 * 2 ** intento));
    }
  }
  m.fallasPaso.inc({ paso: '6', motor: 'mongo' });
  return false;
}

// ---------- La Saga ----------
async function comprar(body, claveHeader) {
  const inicio = process.hrtime.bigint();
  const fin = (resultado) => {
    m.compras.inc({ resultado });
    m.duracion.observe({ resultado }, Number(process.hrtime.bigint() - inicio) / 1e9);
  };
  try {
    const r = await ejecutar(validar(body, claveHeader));
    fin(r.repetida ? 'repetida' : 'confirmada');
    return r;
  } catch (e) {
    if (e instanceof ErrorCompra && e.extra.cancelado) fin('cancelada');
    else if (e instanceof ErrorCompra && e.status < 500) fin('rechazada');
    else fin('error');
    throw e;
  }
}

async function ejecutar(c) {
  // Cada evento guarda la hora en que ocurrió su paso (no la hora en que se escribe en Mongo).
  const eventos = [];
  eventos.push = (...evs) => Array.prototype.push.apply(eventos, evs.map((ev) => ({ fecha: new Date(), ...ev })));
  const fallo = (paso, motor, e) => {
    if (e instanceof ErrorCompra) return e; // regla de negocio (sin stock, carrito vacío…): no es falla del motor
    m.fallasPaso.inc({ paso: String(paso), motor });
    const status = e instanceof ErrorMotor ? 503 : 500;
    return new ErrorCompra(status, e instanceof ErrorMotor ? 'MOTOR_NO_DISPONIBLE' : 'ERROR_INTERNO', e.message, { motor, paso });
  };

  // 0. ¿Esta clave ya se procesó?
  let previo;
  try {
    previo = await conMysql(async (pool) => {
      const [rows] = await pool.query('SELECT id, estado, total, sucursal_id FROM pedidos WHERE clave_idempotencia = ?', [c.clave]);
      return rows[0];
    });
  } catch (e) { throw fallo(0, 'mysql', e); }
  if (previo && previo.estado !== 'PENDIENTE') {
    return { repetida: true, pedido_id: previo.id, estado: previo.estado, total: previo.total, clave: c.clave };
  }

  let pedidoId, items, total, desdeCarrito = false;
  if (previo) {
    // La API se cayó a mitad de una compra anterior con esta clave: continuar desde el paso 4.
    pedidoId = previo.id;
    total = previo.total;
    c.sucursal_id = previo.sucursal_id;
    items = await conMysql(async (pool) => (await pool.query(
      'SELECT producto_id, cantidad FROM detalle_pedido WHERE pedido_id = ? ORDER BY producto_id', [pedidoId]))[0]);
    eventos.push({ tipo: 'SAGA_REANUDADA', paso: 0, motor: 'api', detalle: {} });
  } else {
    // 1. Mongo: carrito (si no mandaron items), catálogo y bitácora de búsqueda
    let catalogo;
    try {
      ({ items, catalogo, desdeCarrito } = await conMongo(async (db) => {
        let its = c.items, carrito = false;
        if (!its) {
          const doc = await db.collection('carritos').findOne({ cliente_id: c.cliente_id });
          if (!doc || !doc.items || !doc.items.length) throw new ErrorCompra(400, 'CARRITO_VACIO', `El cliente ${c.cliente_id} no tiene carrito; manda items`);
          its = doc.items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad }));
          carrito = true;
        }
        its = normalizar(its);
        const ids = its.map((i) => i.producto_id);
        const prods = await db.collection('catalogo')
          .find({ producto_id: { $in: ids }, activo: true }, { projection: { _id: 0, producto_id: 1, nombre: 1, categoria: 1 } }).toArray();
        await db.collection('logs_busqueda').insertOne({
          cliente_id: c.cliente_id, termino: prods[0] ? prods[0].nombre.toLowerCase() : 'sin resultados',
          categoria: prods[0] ? prods[0].categoria : null, resultados: prods.length, sucursal_id: c.sucursal_id, origen: 'compra', fecha: new Date(),
        });
        return { items: its, catalogo: prods, desdeCarrito: carrito };
      }));
    } catch (e) { throw fallo(1, 'mongo', e); }
    const enCatalogo = new Set(catalogo.map((p) => p.producto_id));
    const faltan = items.filter((i) => !enCatalogo.has(i.producto_id)).map((i) => i.producto_id);
    if (faltan.length) throw fallo(1, 'mongo', new ErrorCompra(404, 'PRODUCTO_NO_EXISTE', `Productos fuera del catálogo: ${faltan.join(', ')}`));

    // 2. PostgreSQL (solo lectura): la sucursal existe y vende esos productos; precio local
    let precios;
    try {
      precios = await conPg(async (pool) => {
        const s = await pool.query('SELECT 1 FROM sucursales WHERE id = $1', [c.sucursal_id]);
        if (!s.rowCount) throw new ErrorCompra(404, 'SUCURSAL_NO_EXISTE', `No existe la sucursal ${c.sucursal_id}`);
        const r = await pool.query(
          'SELECT producto_id, precio_local FROM productos_sucursal WHERE sucursal_id = $1 AND producto_id = ANY($2::int[]) AND activo',
          [c.sucursal_id, items.map((i) => i.producto_id)]);
        return new Map(r.rows.map((x) => [x.producto_id, Number(x.precio_local)]));
      });
    } catch (e) { throw fallo(2, 'postgres', e); }
    const noVende = items.filter((i) => !precios.has(i.producto_id)).map((i) => i.producto_id);
    if (noVende.length) throw fallo(2, 'postgres', new ErrorCompra(409, 'NO_SE_VENDE_EN_SUCURSAL', `La sucursal ${c.sucursal_id} no vende: ${noVende.join(', ')}`));
    for (const it of items) it.precio_unitario = precios.get(it.producto_id);
    total = Math.round(items.reduce((s, i) => s + i.cantidad * i.precio_unitario * 100, 0)) / 100;

    // 3. MySQL: pedido PENDIENTE con sus dos fragmentos (pedidos + pedido_cliente) y el detalle
    try {
      pedidoId = await txMysql(async (cx) => {
        const [[cli]] = await cx.query(
          `SELECT c.nombre, c.telefono, d.id AS direccion_id, d.calle, d.ciudad, d.estado, d.cp
           FROM clientes c JOIN direcciones d ON d.cliente_id = c.id AND d.principal = 1 WHERE c.id = ?`, [c.cliente_id]);
        if (!cli) throw new ErrorCompra(404, 'CLIENTE_NO_EXISTE', `No existe el cliente ${c.cliente_id} o no tiene dirección principal`);
        const [p] = await cx.query(
          "INSERT INTO pedidos (cliente_id, sucursal_id, fecha, total, estado, clave_idempotencia) VALUES (?, ?, UTC_TIMESTAMP(), ?, 'PENDIENTE', ?)",
          [c.cliente_id, c.sucursal_id, total, c.clave]);
        await cx.query(
          `INSERT INTO pedido_cliente (pedido_id, direccion_id, destinatario, telefono_contacto, calle, ciudad, estado, cp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.insertId, cli.direccion_id, cli.nombre, cli.telefono, cli.calle, cli.ciudad, cli.estado, cli.cp]);
        await cx.query('INSERT INTO detalle_pedido (pedido_id, producto_id, cantidad, precio_unitario) VALUES ?',
          [items.map((i) => [p.insertId, i.producto_id, i.cantidad, i.precio_unitario])]);
        return p.insertId;
      });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new ErrorCompra(409, 'COMPRA_EN_CURSO', 'Otra petición con la misma clave se está procesando', { clave: c.clave });
      throw fallo(3, 'mysql', e);
    }
    eventos.push({ tipo: 'PEDIDO_CREADO', paso: 3, motor: 'mysql', detalle: { cliente_id: c.cliente_id, sucursal_id: c.sucursal_id, total } });
  }

  // 4. PostgreSQL: reservar inventario
  try {
    await reservarInventario(pedidoId, c.sucursal_id, items);
    eventos.push({ tipo: 'INVENTARIO_RESERVADO', paso: 4, motor: 'postgres', detalle: { lineas: items.length } });
  } catch (e) {
    const err = fallo(4, 'postgres', e);
    eventos.push({ tipo: 'RESERVA_FALLIDA', paso: 4, motor: 'postgres', detalle: { motivo: err.codigo, mensaje: err.message } });
    // Si el COMMIT llegó a PostgreSQL pero se perdió la respuesta, podría haber reservas: se liberan (idempotente).
    if (!(e instanceof ErrorCompra)) {
      await compensar('liberar_reserva', () => liberarReservas(pedidoId), eventos,
        { tipo: 'RESERVA_LIBERADA', paso: 4, motor: 'postgres', detalle: { compensacion: true } });
    }
    const ok = await compensar('cancelar_pedido', () => cancelarPedido(pedidoId), eventos,
      { tipo: 'PEDIDO_CANCELADO', paso: 4, motor: 'mysql', detalle: { compensacion: true } });
    await guardarEventos(pedidoId, eventos);
    err.extra = { ...err.extra, pedido_id: pedidoId, cancelado: ok, clave: c.clave };
    throw err;
  }

  // 5. MySQL: confirmar
  try {
    await conMysql(async (pool) => {
      const [r] = await pool.query("UPDATE pedidos SET estado = 'CONFIRMADO' WHERE id = ? AND estado = 'PENDIENTE'", [pedidoId]);
      if (r.affectedRows === 0) {
        const [[p]] = await pool.query('SELECT estado FROM pedidos WHERE id = ?', [pedidoId]);
        if (!p || p.estado !== 'CONFIRMADO') throw new ErrorCompra(409, 'PEDIDO_CANCELADO', `El pedido ${pedidoId} ya no está pendiente (${p && p.estado})`);
      }
    });
    eventos.push({ tipo: 'PEDIDO_CONFIRMADO', paso: 5, motor: 'mysql', detalle: { total } });
  } catch (e) {
    const err = fallo(5, 'mysql', e);
    eventos.push({ tipo: 'CONFIRMACION_FALLIDA', paso: 5, motor: 'mysql', detalle: { mensaje: err.message } });
    await compensar('liberar_reserva', () => liberarReservas(pedidoId), eventos,
      { tipo: 'RESERVA_LIBERADA', paso: 5, motor: 'postgres', detalle: { compensacion: true } });
    // Si MySQL sigue caído esto falla y el pedido queda PENDIENTE: un reintento con la misma clave lo resuelve.
    const ok = await compensar('cancelar_pedido', () => cancelarPedido(pedidoId), eventos,
      { tipo: 'PEDIDO_CANCELADO', paso: 5, motor: 'mysql', detalle: { compensacion: true } });
    await guardarEventos(pedidoId, eventos);
    err.extra = { ...err.extra, pedido_id: pedidoId, cancelado: ok, clave: c.clave };
    throw err;
  }

  // 6. Mongo: bitácora, carrito y reseña. La compra ya está confirmada: aquí solo se reintenta.
  const advertencias = [];
  if (desdeCarrito || c.resena) {
    try {
      await conMongo(async (db) => {
        if (desdeCarrito) await db.collection('carritos').updateOne({ cliente_id: c.cliente_id }, { $set: { items: [], actualizado: new Date() } });
        if (c.resena) {
          await db.collection('resenas').insertOne({
            producto_id: items[0].producto_id, cliente_id: c.cliente_id, pedido_id: pedidoId,
            calificacion: c.resena.calificacion, comentario: c.resena.comentario, verificada: true, fecha: new Date(),
          });
        }
      });
    } catch (e) {
      m.fallasPaso.inc({ paso: '6', motor: 'mongo' });
      advertencias.push(`carrito/reseña no actualizados: ${e.message}`);
    }
  }
  if (!(await guardarEventos(pedidoId, eventos))) advertencias.push('los eventos de la bitácora no se pudieron guardar');

  return {
    repetida: false, pedido_id: pedidoId, estado: 'CONFIRMADO', total, sucursal_id: c.sucursal_id,
    items: items.map(({ producto_id, cantidad, precio_unitario }) => ({ producto_id, cantidad, precio_unitario })),
    desde_carrito: desdeCarrito, clave: c.clave, ...(advertencias.length ? { advertencias } : {}),
  };
}

module.exports = { comprar, ErrorCompra };
