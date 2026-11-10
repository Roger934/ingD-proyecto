#!/usr/bin/env bash
# Se corre en db2 (primario). Carga los seeds de PostgreSQL (~110k filas) con COPY; el standby los recibe solo.
#   bash scripts/postgres/datos.sh               → crea el esquema si falta y carga (las tablas deben estar vacías)
#   bash scripts/postgres/datos.sh --reiniciar   → BORRA las tablas y todo lo que tengan, y carga de nuevo
set -euo pipefail
source "$(dirname "$0")/../lib.sh"

C=postgres-db2
exigir_contenedor "$C"
bash "$RAIZ/scripts/generar-datos.sh"
bash "$RAIZ/scripts/postgres/esquema.sh" ${1:+"$1"}

hay=$(docker exec -u postgres "$C" psql -Atd ecommerce -c "SELECT count(*) FROM sucursales")
[[ "$hay" == "0" ]] || falla "La tabla sucursales ya tiene $hay filas. Para borrar todo y cargar de nuevo: bash scripts/postgres/datos.sh --reiniciar"

info "Cargando seed/datos/postgres.sql con COPY"
inicio=$SECONDS
docker exec -i -u postgres "$C" psql -q -v ON_ERROR_STOP=1 -d ecommerce < "$RAIZ/seed/datos/postgres.sql"
ok "Carga terminada en $((SECONDS - inicio)) s"

bash "$RAIZ/scripts/conteos.sh" postgres
