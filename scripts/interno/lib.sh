# Funciones comunes. Se carga con:  source "$(dirname "$0")/../lib.sh"  (o ./lib.sh)
# shellcheck shell=bash

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETOS_ENV="$RAIZ/secretos/ingdatos.env"
SECRETOS_KEYFILE="$RAIZ/secretos/mongo-keyfile"

ok()    { printf '\033[32m✔\033[0m %s\n' "$*"; }
info()  { printf '\033[36m→\033[0m %s\n' "$*"; }
aviso() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
falla() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }
titulo(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# Carga las contraseñas como variables de entorno exportadas (no las imprime).
cargar_secretos() {
  [[ -f "$SECRETOS_ENV" ]] || falla "Falta $SECRETOS_ENV. Corre primero: bash scripts/generar-secretos.sh"
  set -a
  # shellcheck disable=SC1090
  source <(tr -d '\r' < "$SECRETOS_ENV")
  set +a
}

contenedor_corriendo() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

exigir_contenedor() {
  contenedor_corriendo "$1" || falla "El contenedor '$1' no está corriendo en esta máquina. ¿Levantaste su rol con 'docker compose up -d'?"
}

# esperar "descripción" intentos comando...   (un intento cada 2 s)
esperar() {
  local desc="$1" intentos="$2"; shift 2
  info "Esperando: $desc"
  local i
  for ((i = 1; i <= intentos; i++)); do
    if "$@" >/dev/null 2>&1; then ok "$desc"; return 0; fi
    sleep 2
  done
  falla "Tiempo agotado esperando: $desc"
}
