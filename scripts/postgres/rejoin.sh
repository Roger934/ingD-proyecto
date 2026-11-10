#!/usr/bin/env bash
# Reengancha el PostgreSQL de ESTA máquina como STANDBY del primario actual (D27).
# Se usa cuando el vigilante avisa que este nodo "no está recibiendo WAL" o quedó "cercado": por
# ejemplo, el viejo primario que regresó después de un apagado brusco y ya no coincide con el nuevo.
# BORRA la copia local y la vuelve a copiar del primario con pg_basebackup (con ~110k filas, segundos).
#   bash scripts/postgres/rejoin.sh db3      (en la máquina que debe volver a ser standby)
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos

PRIMARIO="${1:-}"
[[ "$PRIMARIO" =~ ^db[0-9]$ ]] || falla "Uso: bash scripts/postgres/rejoin.sh <primario: db2|db3>"
C="$(docker ps -a --format '{{.Names}}' | grep -m1 '^postgres-db' || true)"
[[ -n "$C" ]] || falla "No hay un contenedor de PostgreSQL en esta máquina."
ROL="${C#postgres-}"
[[ "$ROL" != "$PRIMARIO" ]] || falla "Esta máquina ES $PRIMARIO: el rejoin se corre en la otra."

if contenedor_corriendo "$C"; then
  estado=$(docker exec -u postgres "$C" psql -Atc "SELECT pg_is_in_recovery()::text || current_setting('default_transaction_read_only')" || true)
  [[ "$estado" != "falseoff" ]] || falla "$C es el primario activo (acepta escrituras). No se reengancha un primario sano."
fi
esperar "$PRIMARIO alcanzable en el puerto 5432" 15 bash -c "exec 3<>/dev/tcp/$PRIMARIO/5432"

read -rp "Se BORRARÁ la copia de PostgreSQL de $ROL y se copiará de nuevo desde $PRIMARIO. Escribe si: " r
[[ "$r" == "si" ]] || falla "Cancelado"

cd "$RAIZ/roles/$ROL"
DC=(docker compose --profile standby)   # en db3 el servicio está en el perfil standby; en db2 no estorba
"${DC[@]}" rm -sf postgres
docker volume rm "ingdatos-${ROL}_pg-data" >/dev/null 2>&1 || true

info "Copiando $PRIMARIO con pg_basebackup"
export PGPASSWORD="$PG_REPL_PASSWORD"
"${DC[@]}" run --rm --no-deps --user postgres -e PGPASSWORD --entrypoint pg_basebackup postgres \
  -h "$PRIMARIO" -p 5432 -U repl_pg -D /var/lib/postgresql/data -R -X stream -P
unset PGPASSWORD

"${DC[@]}" up -d postgres
esperar "PostgreSQL listo en $ROL" 60 docker exec -u postgres "$C" pg_isready -h 127.0.0.1 -p 5432
sleep 2
docker exec -u postgres "$C" psql -d ecommerce -c \
  "SELECT pg_is_in_recovery() AS es_standby, status, sender_host FROM pg_stat_wal_receiver;"
[[ "$(docker exec -u postgres "$C" psql -Atc 'SELECT pg_is_in_recovery()')" == "t" ]] \
  && ok "$ROL es standby de $PRIMARIO" || falla "$ROL no quedó como standby"
