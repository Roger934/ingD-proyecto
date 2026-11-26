#!/usr/bin/env bash
# Muestra el estado de replicación de lo que corre EN ESTA máquina. Se puede correr en cualquiera.
# Para la demo: es lo que se enseña en el paso "Replicación sana" (Plan, sección 7).
set -uo pipefail
source "$(dirname "$0")/lib.sh"
cargar_secretos
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD" MONGO_ADMIN_PASSWORD

locales=$(docker ps --format '{{.Names}}')
[[ -n "$locales" ]] || falla "No hay contenedores corriendo en esta máquina."

mongo_admin() {  # mongo_admin <contenedor> <puerto> <js>
  docker exec -i -e MONGO_ADMIN_PASSWORD "$1" mongosh --quiet --port "$2" --eval \
    "db.getSiblingDB('admin').auth('admin', process.env.MONGO_ADMIN_PASSWORD); $3"
}

for c in $locales; do
  case "$c" in
    mysql-*)
      titulo "MySQL ($c)"
      docker exec -e MYSQL_PWD "$c" mysql --default-character-set=utf8mb4 -uroot -t -e \
        "SELECT @@server_id AS server_id, @@read_only AS read_only, @@super_read_only AS super_ro, @@gtid_executed AS gtid_executed;"
      estado=$(docker exec -e MYSQL_PWD "$c" mysql --default-character-set=utf8mb4 -uroot -e "SHOW REPLICA STATUS\G" 2>/dev/null)
      if [[ -n "$estado" ]]; then
        echo "$estado" | grep -E ' (Source_Host|Replica_IO_Running|Replica_SQL_Running|Seconds_Behind_Source|Last_IO_Error|Last_SQL_Error):'
      else
        echo "Es PRIMARIO. Réplicas conectadas:"
        docker exec -e MYSQL_PWD "$c" mysql --default-character-set=utf8mb4 -uroot -t -e "SHOW REPLICAS;"
      fi
      ;;
    postgres-db*)
      titulo "PostgreSQL ($c)"
      if [[ "$(docker exec -u postgres "$c" psql -Atc 'SELECT pg_is_in_recovery()')" == "f" ]]; then
        echo "Es PRIMARIO. Standbys conectados (pg_stat_replication):"
        docker exec -u postgres "$c" psql -d ecommerce -c \
          "SELECT application_name, client_addr, state, sync_state, replay_lag FROM pg_stat_replication;"
      else
        echo "Es STANDBY (pg_is_in_recovery = true):"
        docker exec -u postgres "$c" psql -d ecommerce -c \
          "SELECT status, sender_host, slot_name, last_msg_receipt_time FROM pg_stat_wal_receiver;"
      fi
      ;;
    mongo-cfg-*)
      titulo "Mongo cfgRS ($c)"
      mongo_admin "$c" 27019 "rs.status().members.forEach(m => print('  ' + m.name.padEnd(12) + m.stateStr))"
      ;;
    mongo-shard-*)
      titulo "Mongo shardA ($c)"
      mongo_admin "$c" 27018 "rs.status().members.forEach(m => print('  ' + m.name.padEnd(12) + m.stateStr))"
      ;;
    mongos-*)
      titulo "Mongo router ($c)"
      mongo_admin "$c" 27017 "
        print('Shards:');
        db.getSiblingDB('admin').runCommand({ listShards: 1 }).shards.forEach(s => print('  ' + s._id + '  ' + s.host));
        print('Colecciones fragmentadas:');
        db.getSiblingDB('config').collections.find({ _id: /^ecommerce\./ }).forEach(c => print('  ' + c._id + '  ' + JSON.stringify(c.key)));"
      ;;
  esac
done
echo
