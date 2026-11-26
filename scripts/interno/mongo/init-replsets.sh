#!/usr/bin/env bash
# Se corre en db1 cuando db1, db2 y db3 ya tienen su rol levantado
# (rs.initiate necesita que los 3 miembros respondan).
# Inicia cfgRS y shardA, y crea los usuarios iniciales por la "localhost exception". Idempotente.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos
export MONGO_ADMIN_PASSWORD MONGO_EXPORTER_PASSWORD

# mongo_js <contenedor> <puerto> <js>   (las contraseñas llegan por process.env)
mongo_js() {
  docker exec -i -e MONGO_ADMIN_PASSWORD -e MONGO_EXPORTER_PASSWORD -e CREAR_EXPORTER \
    "$1" mongosh --quiet --port "$2" --eval "$3"
}

for rol in db2 db3; do
  esperar "Mongo de $rol alcanzable (27019 y 27018)" 60 bash -c "exec 3<>/dev/tcp/$rol/27019 && exec 4<>/dev/tcp/$rol/27018"
done

# iniciar_rs <nombre> <puerto> <contenedor> <configsvr:true|false> <crear_exporter:0|1>
iniciar_rs() {
  local rs="$1" puerto="$2" c="$3" cfg="$4"
  export CREAR_EXPORTER="$5"
  titulo "Replica set $rs (puerto $puerto)"
  exigir_contenedor "$c"
  esperar "mongod $c responde" 60 docker exec "$c" mongosh --quiet --port "$puerto" --eval 'db.hello().ok'

  # 1. rs.initiate solo si todavía no pertenece a un replica set. db1 con prioridad 2 para que sea primario.
  mongo_js "$c" "$puerto" "
    if (db.hello().setName) { print('El replica set ya estaba iniciado'); }
    else {
      rs.initiate({ _id: '$rs', configsvr: $cfg, members: [
        { _id: 0, host: 'db1:$puerto', priority: 2 },
        { _id: 1, host: 'db2:$puerto', priority: 1 },
        { _id: 2, host: 'db3:$puerto', priority: 1 } ] });
      print('rs.initiate enviado');
    }"

  esperar "db1 es PRIMARIO de $rs" 60 docker exec "$c" mongosh --quiet --port "$puerto" \
    --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)'

  # 2. Usuario admin (y exporter en el shard). Si ya existen, solo se actualizan las contraseñas.
  mongo_js "$c" "$puerto" "
    const a = db.getSiblingDB('admin');
    let auth = false;
    try { a.auth('admin', process.env.MONGO_ADMIN_PASSWORD); auth = true; } catch (e) {}
    if (!auth) {
      a.createUser({ user: 'admin', pwd: process.env.MONGO_ADMIN_PASSWORD, roles: ['root'] });
      a.auth('admin', process.env.MONGO_ADMIN_PASSWORD);
      print('Usuario admin creado');
    } else { print('Usuario admin ya existía'); }
    if (process.env.CREAR_EXPORTER === '1') {
      const roles = [ { role: 'clusterMonitor', db: 'admin' }, { role: 'read', db: 'local' } ];
      if (a.getUser('exporter_mongo')) a.updateUser('exporter_mongo', { pwd: process.env.MONGO_EXPORTER_PASSWORD, roles });
      else a.createUser({ user: 'exporter_mongo', pwd: process.env.MONGO_EXPORTER_PASSWORD, roles });
      print('Usuario exporter_mongo listo');
    }
    rs.status().members.forEach(m => print('  ' + m.name + '  ' + m.stateStr));"
  ok "$rs listo"
}

# En cfgRS, los usuarios son los del clúster (los que usa mongos).
# En shardA, son usuarios locales del shard (para mantenimiento y para mongodb_exporter).
iniciar_rs cfgRS  27019 mongo-cfg-db1   true  0
iniciar_rs shardA 27018 mongo-shard-db1 false 1

echo
ok "Replica sets listos. Sigue: en db3, bash scripts/interno/mongo/init-sharding.sh"
