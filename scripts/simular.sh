#!/usr/bin/env bash
# Simulador de transacciones (D26). Se corre en la máquina con el rol app.
#   bash scripts/simular.sh --n 100                 100 compras (10 en paralelo)
#   bash scripts/simular.sh --n 1000 --concurrencia 20
#   bash scripts/simular.sh --tps 20 --minutos 5    carga constante (para las pruebas de falla)
#   bash scripts/simular.sh --n 100 --json > reporte.json
#   bash scripts/simular.sh --ayuda
# Ctrl+C detiene el envío e imprime el reporte de lo que alcanzó a correr.
set -euo pipefail
source "$(dirname "$0")/interno/lib.sh"

[[ -f "$RAIZ/roles/app/.env" ]] || falla "Falta roles/app/.env. Este script se corre en la máquina con el rol app."

flags=()
[[ -t 0 && -t 1 ]] || flags+=(-T)   # sin terminal (p. ej. con > archivo): sin TTY, para no mezclar el progreso con el reporte

cd "$RAIZ/roles/app"
exec docker compose run --rm "${flags[@]}" simulador "$@"
