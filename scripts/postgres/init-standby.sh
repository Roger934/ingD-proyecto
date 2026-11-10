#!/usr/bin/env bash
# Se corre en db3 DESPUÉS de init-primario.sh en db2.
# Copia el primario con pg_basebackup (streaming + slot) y arranca el standby.
#   bash scripts/postgres/init-standby.sh            → solo si el standby aún no existe
#   bash scripts/postgres/init-standby.sh --forzar   → borra el standby actual y lo vuelve a copiar
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos

cd "$RAIZ/roles/db3"
DC=(docker compose --profile standby)
VOL="ingdatos-db3_pg-data"

esperar "db2 alcanzable en el puerto 5432" 30 bash -c 'exec 3<>/dev/tcp/db2/5432'

if docker volume inspect "$VOL" >/dev/null 2>&1; then
  # Usa la misma imagen de postgres (ya descargada): nada extra que bajar sin internet.
  tiene_datos=$(docker run --rm --entrypoint sh -v "$VOL":/d postgres:16.6 -c 'test -f /d/PG_VERSION && echo si || echo no')
else
  tiene_datos=no
fi

if [[ "$tiene_datos" == "si" ]]; then
  if [[ "${1:-}" != "--forzar" ]]; then
    info "El standby ya tiene datos: solo lo arranco. (Para copiarlo de nuevo: --forzar)"
    "${DC[@]}" up -d postgres
    exit 0
  fi
  aviso "Borrando el standby actual de db3 para copiarlo de nuevo desde db2"
  "${DC[@]}" rm -sf postgres
  docker volume rm "$VOL"
fi

info "Copiando el primario db2 con pg_basebackup (puede tardar un poco)"
export PGPASSWORD="$PG_REPL_PASSWORD"
"${DC[@]}" run --rm --no-deps --user postgres -e PGPASSWORD --entrypoint pg_basebackup postgres \
  -h db2 -p 5432 -U repl_pg \
  -D /var/lib/postgresql/data \
  -R -X stream -S standby_db3 -P
unset PGPASSWORD

info "Arrancando el standby"
"${DC[@]}" up -d postgres
esperar "PostgreSQL listo en db3" 60 docker exec -u postgres postgres-db3 pg_isready -h 127.0.0.1 -p 5432

docker exec -u postgres postgres-db3 psql -d ecommerce -c \
  "SELECT pg_is_in_recovery() AS es_standby, status, sender_host FROM pg_stat_wal_receiver;"
if [[ "$(docker exec -u postgres postgres-db3 psql -Atc 'SELECT pg_is_in_recovery()')" == "t" ]]; then
  ok "Streaming Replication db2 → db3 funcionando"
else
  falla "db3 no quedó en modo standby"
fi
