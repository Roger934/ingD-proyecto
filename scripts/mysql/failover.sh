#!/usr/bin/env bash
# Promueve a PRIMARIO el MySQL de ESTA máquina. Es el respaldo manual del vigilante (D27).
# Úsalo solo si el vigilante no lo hizo. Antes, asegúrate de que el otro MySQL esté caído o en
# solo lectura: si no, habría dos primarios.
#   bash scripts/mysql/failover.sh
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"

C="$(docker ps --format '{{.Names}}' | grep -m1 '^mysql-db' || true)"
[[ -n "$C" ]] || falla "No hay un MySQL corriendo en esta máquina."
sql() { docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot "$@"; }

[[ "$(sql -N -e 'SELECT @@global.read_only')" == "1" ]] || { ok "$C ya es primario (acepta escrituras)."; exit 0; }
read -rp "¿Promover $C a PRIMARIO? Escribe si: " r
[[ "$r" == "si" ]] || falla "Cancelado"

recibido=$(sql -N -e "SELECT IFNULL(REPLACE(RECEIVED_TRANSACTION_SET, '\n', ''), '') FROM performance_schema.replication_connection_status" || true)
if [[ -n "$recibido" ]]; then
  info "Aplicando lo que ya llegó del primario anterior (máximo 10 s)"
  sql -N -e "SELECT WAIT_FOR_EXECUTED_GTID_SET('$recibido', 10)" >/dev/null || true
fi
sql <<'SQL'
STOP REPLICA;
RESET REPLICA ALL;
SET GLOBAL super_read_only = OFF;
SET GLOBAL read_only = OFF;   -- GLOBAL y no PERSIST: si se reinicia vuelve en solo lectura (D27)
SQL
sql -t -e "SELECT @@hostname AS contenedor, @@server_id AS server_id, @@read_only AS read_only, @@super_read_only AS super_ro;"
ok "$C es el nuevo primario. Cuando el otro regrese, el vigilante lo reengancha (o: bash scripts/mysql/rejoin.sh <este rol> en esa máquina)."
