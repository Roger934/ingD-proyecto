#!/usr/bin/env bash
# Reengancha el MySQL de ESTA máquina como RÉPLICA del primario actual. Respaldo manual del vigilante (D27),
# que normalmente lo hace solo.
#   bash scripts/mysql/rejoin.sh db2                 → réplica de db2 por GTID (si los datos son compatibles)
#   bash scripts/mysql/rejoin.sh db2 --reconstruir   → BORRA este MySQL y lo vuelve a crear como réplica de db2
#                                                      (cuando tiene transacciones que el primario no tiene)
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD" MYSQL_FAILOVER_PASSWORD

PRIMARIO="${1:-}"
[[ "$PRIMARIO" =~ ^db[0-9]$ ]] || falla "Uso: bash scripts/mysql/rejoin.sh <primario: db1|db2> [--reconstruir]"
C="$(docker ps -a --format '{{.Names}}' | grep -m1 '^mysql-db' || true)"
[[ -n "$C" ]] || falla "No hay un contenedor de MySQL en esta máquina."
ROL="${C#mysql-}"
[[ "$ROL" != "$PRIMARIO" ]] || falla "Esta máquina ES $PRIMARIO: el rejoin se corre en la otra."
sql() { docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot "$@"; }
# Consulta al primario con el usuario del vigilante. La contraseña viaja por variable de entorno, no por la línea de comandos.
en_primario() { docker exec -i -e MYSQL_FAILOVER_PASSWORD "$C" sh -c \
  'MYSQL_PWD="$MYSQL_FAILOVER_PASSWORD" exec mysql -h "$0" -ufailover_mysql -N "$@"' "$PRIMARIO" "$@"; }

configurar_replica() {
  sql <<SQL
STOP REPLICA;
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = '${PRIMARIO}', SOURCE_PORT = 3306,
  SOURCE_USER = 'repl_mysql', SOURCE_PASSWORD = '${MYSQL_REPL_PASSWORD}',
  SOURCE_AUTO_POSITION = 1, SOURCE_SSL = 1, GET_SOURCE_PUBLIC_KEY = 1,
  SOURCE_CONNECT_RETRY = 10, SOURCE_RETRY_COUNT = 8640;
START REPLICA;
SET PERSIST read_only = ON;
SET PERSIST super_read_only = ON;
SQL
}

if [[ "${2:-}" == "--reconstruir" ]]; then
  read -rp "Se BORRARÁN todos los datos de $C y se copiarán de nuevo desde $PRIMARIO. Escribe si: " r
  [[ "$r" == "si" ]] || falla "Cancelado"
  cd "$RAIZ/roles/$ROL"
  docker compose rm -sf mysql
  docker volume rm "ingdatos-${ROL}_mysql-data"
  docker compose up -d mysql
  esperar "MySQL nuevo listo en $ROL" 120 docker exec "$C" mysqladmin --protocol=TCP -h127.0.0.1 -P3306 ping
  info "Configurando la réplica desde cero: replicará toda la historia del binlog de $PRIMARIO"
  sql -e "SET GLOBAL super_read_only = OFF; RESET BINARY LOGS AND GTIDS;"
  configurar_replica
else
  exigir_contenedor "$C"
  [[ "$(sql -N -e 'SELECT @@global.read_only')" == "1" ]] \
    || falla "$C acepta escrituras (es primario). Si de verdad debe ser réplica, primero: SET GLOBAL super_read_only = ON"
  gtid=$(sql -N -e "SELECT REPLACE(@@global.gtid_executed, '\n', '')")
  compatible=$(en_primario -e "SELECT GTID_SUBSET('$gtid', @@global.gtid_executed)") \
    || falla "No pude consultar a $PRIMARIO con el usuario failover_mysql. ¿Está arriba?"
  [[ "$compatible" == "1" ]] || falla "$C tiene transacciones que $PRIMARIO no tiene. Usa: bash scripts/mysql/rejoin.sh $PRIMARIO --reconstruir"
  info "Reenganchando $C como réplica de $PRIMARIO"
  sql -e "SET GLOBAL read_only = ON; SET GLOBAL super_read_only = OFF;"
  configurar_replica
fi

sleep 3
sql -e "SHOW REPLICA STATUS\G" | grep -E ' (Source_Host|Replica_IO_Running|Replica_SQL_Running|Seconds_Behind_Source|Last_IO_Error|Last_SQL_Error):' || true
ok "$C es réplica de $PRIMARIO"
