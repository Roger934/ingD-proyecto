#!/usr/bin/env bash
# Genera seed/datos/ (catálogo maestro + seeds de los 3 motores) con seed/generar.js.
# Es determinista: en cualquier máquina salen los mismos datos, así que cada máquina puede generarlos ella misma.
# Usa Node si la máquina lo tiene (≥ 18); si no, lo corre en un contenedor de Node.
#   bash scripts/generar-datos.sh            → solo si todavía no existen
#   bash scripts/generar-datos.sh --forzar   → los vuelve a generar
set -euo pipefail
source "$(dirname "$0")/lib.sh"

IMAGEN_NODE=node:22.12.0-bookworm-slim

if [[ -s "$RAIZ/seed/datos/resumen.json" && "${1:-}" != "--forzar" ]]; then
  ok "Los datos ya están generados en seed/datos/"
  exit 0
fi

info "Generando el catálogo maestro y los seeds en seed/datos/"
if command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  node "$RAIZ/seed/generar.js"
else
  docker run --rm -u "$(id -u):$(id -g)" -v "$RAIZ:/repo" -w /repo "$IMAGEN_NODE" node seed/generar.js
fi
ok "Datos generados"
