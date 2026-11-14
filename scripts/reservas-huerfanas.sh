#!/usr/bin/env bash
# Revisa y libera reservas huérfanas: reservas ACTIVA (PostgreSQL) de pedidos CANCELADO (MySQL).
# Quedan así cuando la compensación liberar_reserva de la Saga falla durante una caída de PostgreSQL.
# Se corre en la máquina con el rol app, después de las pruebas de falla y antes de la demo.
#   bash scripts/reservas-huerfanas.sh             → solo revisa (no cambia nada)
#   bash scripts/reservas-huerfanas.sh --liberar   → las libera: devuelve el inventario y anota LIBERACION
# Termina con 0 si no hay huérfanas (o si se liberaron), 1 si hay y no se liberaron, 2 si hubo un error.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

case "${1:-}" in
  ""|--liberar) ;;
  *) falla "Uso: bash scripts/reservas-huerfanas.sh [--liberar]" ;;
esac
exigir_contenedor api-app

# El .js entra por la entrada estándar: así no hay que reconstruir la imagen de la API.
docker exec -i api-app node - "$@" < "$(dirname "$0")/reservas-huerfanas.js"
