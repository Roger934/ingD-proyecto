#!/usr/bin/env bash
# Se corre en db2 (primario). Crea las 5 tablas con inventario y movimientos particionadas
# por sucursal (db/postgres/schema.sql). El standby las recibe solo por streaming. Idempotente.
#   bash scripts/interno/postgres/esquema.sh               → crea lo que falte
#   bash scripts/interno/postgres/esquema.sh --reiniciar   → BORRA las tablas y sus datos, y las vuelve a crear
set -euo pipefail
source "$(dirname "$0")/../lib.sh"

C=postgres-db2
exigir_contenedor "$C"
[[ "$(docker exec -u postgres "$C" psql -Atc 'SELECT pg_is_in_recovery()')" == "f" ]] \
  || falla "Este PostgreSQL es standby. El esquema se aplica en el primario."

if [[ "${1:-}" == "--reiniciar" ]]; then
  aviso "Borrando las tablas de ecommerce en PostgreSQL (y sus datos)"
  docker exec -u postgres "$C" psql -v ON_ERROR_STOP=1 -d ecommerce -c \
    "DROP TABLE IF EXISTS movimientos, reservas, inventario, productos_sucursal, sucursales CASCADE;"
fi

info "Aplicando db/postgres/schema.sql"
docker exec -i -u postgres "$C" psql -q -v ON_ERROR_STOP=1 -d ecommerce < "$RAIZ/db/postgres/schema.sql"

docker exec -u postgres "$C" psql -d ecommerce -c "
  SELECT c.relname AS tabla,
         CASE WHEN c.relkind = 'p' THEN 'particionada' WHEN i.inhparent IS NOT NULL THEN 'partición de ' || p.relname ELSE 'normal' END AS tipo
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
  LEFT JOIN pg_class p ON p.oid = i.inhparent
  WHERE c.relkind IN ('r', 'p')
  ORDER BY coalesce(p.relname, c.relname), c.relname;"
ok "Esquema de PostgreSQL listo (5 tablas; inventario y movimientos particionadas por sucursal)"
