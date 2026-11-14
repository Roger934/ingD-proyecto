// Reservas huérfanas: reservas ACTIVA (PostgreSQL) de pedidos CANCELADO (MySQL).
// Aparecen cuando la compensación liberar_reserva de la Saga falla (por ejemplo, PostgreSQL caído
// justo en ese momento): el pedido se cancela pero el inventario se queda apartado.
//
// No se corre directo: lo lanza scripts/reservas-huerfanas.sh dentro del contenedor api-app, para
// usar las mismas conexiones de la API (encuentra solo al primario de cada motor).
//   sin argumentos → solo revisa        --liberar → además las libera
'use strict';
const db = require('/app/src/db.js');
const liberar = process.argv.includes('--liberar');

// Misma lógica que liberarReservas() en api/src/saga.js: idempotente, solo toca reservas ACTIVA.
async function liberarReservas(pedidoId) {
  return db.txPg(async (cx) => {
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

async function principal() {
  const cancelados = await db.conMysql(async (pool) => {
    const [filas] = await pool.query("SELECT id FROM pedidos WHERE estado = 'CANCELADO'");
    return filas.map((f) => String(f.id));
  });
  const huerfanas = cancelados.length === 0 ? [] : await db.conPg(async (pool) => (await pool.query(
    `SELECT pedido_id::text AS pedido_id, count(*)::int AS lineas, sum(cantidad)::int AS unidades,
            to_char(min(creado), 'YYYY-MM-DD HH24:MI') AS desde
     FROM reservas WHERE estado = 'ACTIVA' AND pedido_id = ANY($1::bigint[])
     GROUP BY pedido_id ORDER BY pedido_id`, [cancelados])).rows);

  const unidades = huerfanas.reduce((s, h) => s + h.unidades, 0);
  console.log(`Primarios: MySQL ${db.hosts.mysql()} · PostgreSQL ${db.hosts.postgres()}`);
  console.log(`Pedidos CANCELADO en MySQL:              ${cancelados.length}`);
  console.log(`  de ellos, con reservas ACTIVA:         ${huerfanas.length}`);
  console.log(`  unidades de inventario apartadas:      ${unidades}`);
  if (huerfanas.length === 0) { console.log('Sin reservas huérfanas.'); return 0; }

  console.log('\n  pedido_id   líneas  unidades  reservado desde');
  for (const h of huerfanas.slice(0, 20)) {
    console.log(`  ${h.pedido_id.padEnd(10)}  ${String(h.lineas).padStart(6)}  ${String(h.unidades).padStart(8)}  ${h.desde}`);
  }
  if (huerfanas.length > 20) console.log(`  … y ${huerfanas.length - 20} pedidos más`);

  if (!liberar) {
    console.log('\nNo se cambió nada. Para liberarlas: bash scripts/reservas-huerfanas.sh --liberar');
    return 1;
  }

  let pedidos = 0, lineas = 0, saltados = 0;
  for (const h of huerfanas) {
    // Se vuelve a confirmar en MySQL justo antes: solo se libera si el pedido sigue CANCELADO.
    const estado = await db.conMysql(async (pool) => {
      const [[p]] = await pool.query('SELECT estado FROM pedidos WHERE id = ?', [h.pedido_id]);
      return p && p.estado;
    });
    if (estado !== 'CANCELADO') { saltados++; continue; }
    lineas += await liberarReservas(h.pedido_id);
    pedidos++;
  }
  console.log(`\nLiberadas: ${lineas} reservas de ${pedidos} pedidos (${unidades} unidades de vuelta al inventario).`);
  if (saltados) console.log(`Saltados: ${saltados} pedidos que ya no estaban CANCELADO.`);
  return 0;
}

principal()
  .then(async (codigo) => { await db.cerrar().catch(() => {}); process.exit(codigo); })
  .catch(async (e) => { console.error('Error:', e.message); await db.cerrar().catch(() => {}); process.exit(2); });
