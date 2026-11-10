#!/usr/bin/env bash
# Se corre en db3 (donde vive mongos-db3) DESPUÉS de init-replsets.sh en db1.
# Agrega shardA al clúster, crea los usuarios de la app y del exporter y fragmenta
# las colecciones catalogo y eventos con llave hashed (D9). Idempotente.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos
export MONGO_ADMIN_PASSWORD MONGO_EXPORTER_PASSWORD MONGO_APP_PASSWORD

C=mongos-db3
exigir_contenedor "$C"
esperar "mongos responde en db3" 60 docker exec "$C" mongosh --quiet --port 27017 --eval 'db.adminCommand({ ping: 1 }).ok'

docker exec -i -e MONGO_ADMIN_PASSWORD -e MONGO_EXPORTER_PASSWORD -e MONGO_APP_PASSWORD \
  "$C" mongosh --quiet --port 27017 --eval "
  const a = db.getSiblingDB('admin');
  a.auth('admin', process.env.MONGO_ADMIN_PASSWORD);

  // 1. Shard
  const shards = a.runCommand({ listShards: 1 }).shards.map(s => s._id);
  if (!shards.includes('shardA')) { sh.addShard('shardA/db1:27018,db2:27018,db3:27018'); print('shardA agregado'); }
  else print('shardA ya estaba en el clúster');

  // 2. Usuarios del clúster
  const usuarios = [
    { user: 'app_ecommerce',  pwd: process.env.MONGO_APP_PASSWORD,      roles: [ { role: 'readWrite', db: 'ecommerce' } ] },
    { user: 'exporter_mongo', pwd: process.env.MONGO_EXPORTER_PASSWORD, roles: [ { role: 'clusterMonitor', db: 'admin' }, { role: 'read', db: 'local' } ] },
  ];
  for (const u of usuarios) {
    if (a.getUser(u.user)) a.updateUser(u.user, { pwd: u.pwd, roles: u.roles });
    else a.createUser(u);
    print('Usuario ' + u.user + ' listo');
  }

  // 3. Sharding de la base y de las 2 colecciones grandes (D9)
  sh.enableSharding('ecommerce');
  for (const [col, llave] of [ ['catalogo', { producto_id: 'hashed' }], ['eventos', { pedido_id: 'hashed' }] ]) {
    try { sh.shardCollection('ecommerce.' + col, llave); print('ecommerce.' + col + ' fragmentada por ' + JSON.stringify(llave)); }
    catch (e) { print('ecommerce.' + col + ': ' + e.message); }
  }

  print('');
  print('Shards:');
  a.runCommand({ listShards: 1 }).shards.forEach(s => print('  ' + s._id + '  ' + s.host));
  print('Colecciones fragmentadas:');
  db.getSiblingDB('config').collections.find({ _id: /^ecommerce\./ }).forEach(c => print('  ' + c._id + '  ' + JSON.stringify(c.key)));
"
ok "Sharding listo"
