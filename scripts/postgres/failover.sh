#!/usr/bin/env bash
# Promueve a PRIMARIO el PostgreSQL de ESTA máquina. Es el respaldo manual del vigilante (D27).
# Úsalo solo si el vigilante no lo hizo y el otro PostgreSQL está caído.
#   bash scripts/postgres/failover.sh
set -euo pipefail
source "$(dirname "$0")/../lib.sh"

C="$(docker ps --format '{{.Names}}' | grep -m1 '^postgres-db' || true)"
[[ -n "$C" ]] || falla "No hay un PostgreSQL corriendo en esta máquina."
psql_() { docker exec -u postgres "$C" psql -d ecommerce -v ON_ERROR_STOP=1 "$@"; }

if [[ "$(psql_ -Atc 'SELECT pg_is_in_recovery()')" == "f" ]]; then
  psql_ -c "ALTER SYSTEM RESET default_transaction_read_only" -c "SELECT pg_reload_conf()" >/dev/null
  ok "$C ya es primario."
  exit 0
fi
read -rp "¿Promover $C a PRIMARIO? Escribe si: " r
[[ "$r" == "si" ]] || falla "Cancelado"

psql_ -c "SELECT pg_promote(true, 30) AS promovido;"
psql_ -c "ALTER SYSTEM RESET default_transaction_read_only" -c "SELECT pg_reload_conf()" >/dev/null
psql_ -c "SELECT pg_is_in_recovery() AS es_standby, current_setting('default_transaction_read_only') AS solo_lectura;"
ok "$C es el nuevo primario. Para reenganchar al otro, en esa máquina: bash scripts/postgres/rejoin.sh ${C#postgres-}"
