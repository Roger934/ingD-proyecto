#!/usr/bin/env bash
# Se corre en db2 DESPUÉS de init-primario.sh en db1. Conecta la réplica al primario por GTID.
# Idempotente: si la réplica ya está configurada, solo la arranca y muestra su estado.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos

C=mysql-db2
exigir_contenedor "$C"
esperar "MySQL listo en db2" 90 docker exec "$C" mysqladmin --protocol=TCP -h127.0.0.1 -P3306 ping
esperar "db1 alcanzable en el puerto 3306" 30 bash -c 'exec 3<>/dev/tcp/db1/3306'

export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"
sql() { docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot "$@"; }

configurada=$(sql -N -e "SELECT COUNT(*) FROM performance_schema.replication_connection_configuration;")
if [[ "$configurada" == "0" ]]; then
  info "Configurando la réplica (primera vez)"
  sql <<SQL
SET GLOBAL super_read_only = OFF;
RESET BINARY LOGS AND GTIDS;   -- la réplica arranca vacía: todo vendrá de db1
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = 'db1',
  SOURCE_PORT = 3306,
  SOURCE_USER = 'repl_mysql',
  SOURCE_PASSWORD = '${MYSQL_REPL_PASSWORD}',
  SOURCE_AUTO_POSITION = 1,
  SOURCE_SSL = 1,
  GET_SOURCE_PUBLIC_KEY = 1,
  SOURCE_CONNECT_RETRY = 10,
  SOURCE_RETRY_COUNT = 8640;
START REPLICA;
SET PERSIST read_only = ON;
SET PERSIST super_read_only = ON;
SQL
else
  info "La réplica ya estaba configurada: solo me aseguro de que esté corriendo"
  sql -e "START REPLICA;" || true
fi

sleep 3
info "Estado de la réplica:"
sql -e "SHOW REPLICA STATUS\G" | grep -E ' (Source_Host|Replica_IO_Running|Replica_SQL_Running|Seconds_Behind_Source|Last_IO_Error|Last_SQL_Error|Executed_Gtid_Set):' || true

io=$(sql -N -e "SELECT SERVICE_STATE FROM performance_schema.replication_connection_status;")
sqlt=$(sql -N -e "SELECT SERVICE_STATE FROM performance_schema.replication_applier_status;")
if [[ "$io" == "ON" && "$sqlt" == "ON" ]]; then ok "Replicación MySQL db1 → db2 funcionando"
else falla "La réplica no quedó corriendo (IO=$io, SQL=$sqlt). Revisa Last_IO_Error arriba"; fi
