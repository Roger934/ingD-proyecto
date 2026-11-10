// MongoDB 7 — base ecommerce: las 5 colecciones y sus índices.
// Lo corre scripts/mongo/esquema.sh contra un mongos, ya autenticado como admin.
// catalogo y eventos ya están fragmentadas (init-sharding.sh, D9); aquí no se toca el sharding.
// Idempotente: createCollection y createIndex no fallan si ya existen.
const e = db.getSiblingDB('ecommerce');

const colecciones = {
  // producto con atributos variables según la categoría. Shard key: { producto_id: 'hashed' }
  catalogo: [
    [{ categoria: 1, precio_lista: 1 }],
    [{ sku: 1 }],
  ],
  // bitácora de cada etapa de la compra. Shard key: { pedido_id: 'hashed' }
  eventos: [
    [{ pedido_id: 1, fecha: 1 }],
    [{ tipo: 1, fecha: -1 }],
  ],
  resenas: [
    [{ producto_id: 1, fecha: -1 }],
    [{ cliente_id: 1 }],
  ],
  // un carrito por cliente
  carritos: [
    [{ cliente_id: 1 }, { unique: true }],
  ],
  logs_busqueda: [
    [{ fecha: -1 }],
    [{ cliente_id: 1, fecha: -1 }],
  ],
};

const existentes = e.getCollectionNames();
for (const [nombre, indices] of Object.entries(colecciones)) {
  if (!existentes.includes(nombre)) e.createCollection(nombre);
  if (process.env.REINICIAR === '1') {
    // Se vacía en vez de borrar la colección: así no se pierde el sharding.
    const r = e.getCollection(nombre).deleteMany({});
    print('  ' + nombre + ': ' + r.deletedCount + ' documentos borrados');
  }
  for (const [llaves, opciones] of indices) e.getCollection(nombre).createIndex(llaves, opciones || {});
}

print('Colecciones e índices de ecommerce:');
for (const nombre of Object.keys(colecciones)) {
  const idx = e.getCollection(nombre).getIndexes().map(i => i.name).join(', ');
  print('  ' + nombre.padEnd(14) + idx);
}
