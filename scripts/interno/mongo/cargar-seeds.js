// Lo corre scripts/interno/mongo/datos.sh DENTRO del contenedor mongos (mongosh --file).
// Lee /tmp/seed/<coleccion>.ndjson y lo inserta por lotes. Las fechas vienen en ISO y aquí se vuelven Date.
const fs = require('fs');
db.getSiblingDB('admin').auth('admin', process.env.MONGO_ADMIN_PASSWORD);
const e = db.getSiblingDB('ecommerce');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const reviver = (k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v);
const LOTE = 1000;

for (const col of ['catalogo', 'resenas', 'carritos', 'logs_busqueda', 'eventos']) {
  const lineas = fs.readFileSync('/tmp/seed/' + col + '.ndjson', 'utf8').split('\n').filter(Boolean);
  let insertados = 0;
  for (let i = 0; i < lineas.length; i += LOTE) {
    const docs = lineas.slice(i, i + LOTE).map((l) => JSON.parse(l, reviver));
    insertados += Object.keys(e.getCollection(col).insertMany(docs, { ordered: false }).insertedIds).length;
  }
  print('  ' + col.padEnd(14) + insertados);
}
