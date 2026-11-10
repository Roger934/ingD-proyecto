#!/usr/bin/env bash
# Se corre en db2, con su rol ya levantado. Crea los roles por función. (Sin replication slots: D27.)
# Idempotente.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos

C=postgres-db2
exigir_contenedor "$C"
esperar "PostgreSQL listo en db2" 90 docker exec -u postgres "$C" pg_isready -h 127.0.0.1 -p 5432

info "Creando roles (repl, exporter, app)"
# Las contraseñas entran por variables de entorno (\getenv), no por la línea de comandos.
docker exec -i -u postgres \
  -e PG_REPL_PASSWORD -e PG_EXPORTER_PASSWORD -e PG_APP_PASSWORD -e PG_FAILOVER_PASSWORD \
  "$C" psql -v ON_ERROR_STOP=1 -d ecommerce <<'SQL'
\getenv repl_pw PG_REPL_PASSWORD
\getenv exp_pw  PG_EXPORTER_PASSWORD
\getenv app_pw  PG_APP_PASSWORD
\getenv fo_pw   PG_FAILOVER_PASSWORD

SELECT 'CREATE ROLE repl_pg'       WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'repl_pg')       \gexec
SELECT 'CREATE ROLE exporter_pg'   WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'exporter_pg')   \gexec
SELECT 'CREATE ROLE app_ecommerce' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_ecommerce') \gexec

ALTER ROLE repl_pg       WITH LOGIN REPLICATION PASSWORD :'repl_pw';
ALTER ROLE exporter_pg   WITH LOGIN CONNECTION LIMIT 3 PASSWORD :'exp_pw';
ALTER ROLE app_ecommerce WITH LOGIN PASSWORD :'app_pw';

GRANT pg_monitor TO exporter_pg;
GRANT CONNECT ON DATABASE ecommerce TO app_ecommerce;
GRANT USAGE, CREATE ON SCHEMA public TO app_ecommerce;

-- Vigilante de failover (D27): promover, leer el estado de la replicación y "cercar" un primario sobrante.
SELECT 'CREATE ROLE failover_pg' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'failover_pg') \gexec
ALTER ROLE failover_pg WITH LOGIN CONNECTION LIMIT 5 PASSWORD :'fo_pw';
GRANT CONNECT ON DATABASE ecommerce TO failover_pg;
GRANT pg_monitor, pg_signal_backend TO failover_pg;
GRANT EXECUTE ON FUNCTION pg_promote(boolean, integer) TO failover_pg;
GRANT EXECUTE ON FUNCTION pg_reload_conf() TO failover_pg;
GRANT ALTER SYSTEM ON PARAMETER default_transaction_read_only TO failover_pg;

-- D27: sin replication slots. Si quedó el de la etapa 2 y ya nadie lo usa, se borra (si no, guardaría WAL sin fin).
SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE NOT active;
SQL

docker exec -u postgres "$C" psql -d ecommerce -c \
  "SELECT pg_is_in_recovery() AS es_standby, current_setting('wal_level') AS wal_level, (SELECT string_agg(slot_name, ', ') FROM pg_replication_slots) AS slots;"
ok "db2 listo como primario. Sigue: en db3, bash scripts/postgres/init-standby.sh"
