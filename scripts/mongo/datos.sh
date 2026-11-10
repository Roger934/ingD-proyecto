#!/usr/bin/env bash
# Se corre donde haya un mongos (db3 o app). Carga los seeds de Mongo (~88k documentos) con insertMany.
#   bash scripts/mongo/datos.sh               → crea colecciones e índices si faltan y carga (deben estar vacías)
#   bash scripts/mongo/datos.sh --reiniciar   → VACÍA las 5 colecciones y carga de nuevo
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos
export MONGO_ADMIN_PASSWORD

C="$(docker ps --format '{{.Names}}' | grep -m1 '^mongos-' || true)"
[[ -n "$C" ]] || falla "No hay un mongos corriendo en esta máquina (está en db3 y en app)."
bash "$RAIZ/scripts/generar-datos.sh"
bash "$RAIZ/scripts/mongo/esquema.sh" ${1:+"$1"}

mongo() { docker exec -i -e MONGO_ADMIN_PASSWORD "$C" mongosh --quiet --port 27017 --eval \
  "db.getSiblingDB('admin').auth('admin', process.env.MONGO_ADMIN_PASSWORD); $1"; }

hay=$(mongo "print(db.getSiblingDB('ecommerce').catalogo.estimatedDocumentCount())" | tail -1)
[[ "$hay" == "0" ]] || falla "catalogo ya tiene $hay documentos. Para vaciar y cargar de nuevo: bash scripts/mongo/datos.sh --reiniciar"

info "Copiando seed/datos/*.ndjson al contenedor $C"
docker exec "$C" mkdir -p /tmp/seed
for f in "$RAIZ"/seed/datos/*.ndjson "$RAIZ/scripts/mongo/cargar-seeds.js"; do
  docker cp "$f" "$C:/tmp/seed/" >/dev/null
done

info "Insertando por lotes de 1000 (tarda uno o dos minutos)"
inicio=$SECONDS
docker exec -e MONGO_ADMIN_PASSWORD "$C" mongosh --quiet --port 27017 --file /tmp/seed/cargar-seeds.js
docker exec "$C" rm -rf /tmp/seed
ok "Carga terminada en $((SECONDS - inicio)) s"

bash "$RAIZ/scripts/conteos.sh" mongo
