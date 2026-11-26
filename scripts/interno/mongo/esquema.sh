#!/usr/bin/env bash
# Se corre donde haya un mongos (db3 o app). Crea las 5 colecciones y sus índices (db/mongo/init.js).
# No toca el sharding de catalogo y eventos (eso lo hizo init-sharding.sh). Idempotente.
#   bash scripts/interno/mongo/esquema.sh               → crea lo que falte
#   bash scripts/interno/mongo/esquema.sh --reiniciar   → VACÍA las 5 colecciones (conserva sharding e índices)
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos
export MONGO_ADMIN_PASSWORD

C="$(docker ps --format '{{.Names}}' | grep -m1 '^mongos-' || true)"
[[ -n "$C" ]] || falla "No hay un mongos corriendo en esta máquina (está en db3 y en app)."

export REINICIAR=0
if [[ "${1:-}" == "--reiniciar" ]]; then
  aviso "Vaciando las 5 colecciones de ecommerce en MongoDB"
  REINICIAR=1
fi

info "Aplicando db/mongo/init.js por $C"
JS="$(cat "$RAIZ/db/mongo/init.js")"
docker exec -i -e MONGO_ADMIN_PASSWORD -e REINICIAR "$C" mongosh --quiet --port 27017 --eval "
  db.getSiblingDB('admin').auth('admin', process.env.MONGO_ADMIN_PASSWORD);
  $JS
"
ok "Colecciones de MongoDB listas"
