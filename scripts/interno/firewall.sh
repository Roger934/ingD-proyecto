#!/usr/bin/env bash
# Firewall (ufw) de ESTA máquina: cierra todo lo que entra y abre solo los puertos de sus roles,
# y solo desde la LAN. La salida no se toca. Sirve con Docker porque los contenedores usan
# network_mode: host (D2): no hay puertos publicados que se salten a ufw.
# Excepción: el rol mon publica 3000 y 9090 con Docker, y Docker abre esos dos por su cuenta sin
# pasar por ufw (quedan abiertos a quien alcance la máquina, no solo a la LAN).
#
#   bash scripts/interno/firewall.sh                          → solo muestra lo que haría (no cambia nada)
#   sudo bash scripts/interno/firewall.sh --aplicar           → borra las reglas anteriores de ufw, pone estas y lo activa
#   sudo bash scripts/interno/firewall.sh --aplicar --abrir 27100   → además deja abierto un puerto ajeno al proyecto
#                                                       (se puede repetir --abrir; queda abierto como hoy, sin limitar a la LAN)
#
# Los roles se detectan por los contenedores de la máquina (db1, db2, db3, app, mon). Para forzarlos:
#   ROLES="db3" bash scripts/interno/firewall.sh        Otra red:  LAN=10.0.0.0/24 bash scripts/interno/firewall.sh
# Para quitarlo:  sudo ufw disable
set -euo pipefail
source "$(dirname "$0")/lib.sh"

LAN="${LAN:-192.168.1.0/24}"
COMUNES="22 9100"   # SSH y node exporter, en todas
declare -A PUERTOS=(
  [db1]="3306 9104 27018 27019 9216"
  [db2]="3306 9104 5432 9187 27018 27019 9216"
  [db3]="5432 9187 27017 27018 27019 9216 9217"
  [app]="8080 8090 27017 9217"
  [mon]="9090 3000"
)

APLICAR=0
EXTRAS=()
while (( $# )); do
  case "$1" in
    --aplicar) APLICAR=1 ;;
    --abrir)
      shift
      [[ "${1:-}" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )) || falla "--abrir necesita un número de puerto (1 a 65535)"
      EXTRAS+=("$1") ;;
    *) falla "Uso: bash scripts/interno/firewall.sh [--aplicar] [--abrir PUERTO]..." ;;
  esac
  shift
done

# ---------- Roles de esta máquina ----------
if [[ -z "${ROLES:-}" ]]; then
  nombres="$(docker ps -a --format '{{.Names}}')" || falla "No pude consultar Docker. ¿Está corriendo?"
  ROLES="$( { grep -oE -- '-(db[0-9]|app)$' <<<"$nombres" | tr -d '-'
              grep -qxE 'prometheus|grafana' <<<"$nombres" && echo mon; } | sort -u | tr '\n' ' ' || true)"
fi
[[ -n "${ROLES// /}" ]] || falla "Esta máquina no tiene contenedores del proyecto. Indica los roles: ROLES=\"db3\" bash scripts/interno/firewall.sh"

puertos="$COMUNES"
for rol in $ROLES; do
  [[ -n "${PUERTOS[$rol]:-}" ]] || falla "Rol desconocido: $rol (válidos: ${!PUERTOS[*]})"
  puertos+=" ${PUERTOS[$rol]}"
done
puertos="$(tr ' ' '\n' <<<"$puertos" | sort -un | tr '\n' ' ')"

# ---------- Red interna de Docker (rol mon) ----------
# Prometheus y Grafana no usan la red del host: salen por una red interna de Docker (172.x). Para leer
# las métricas de los servicios de ESTA misma máquina llegan con esa dirección, no con una de la LAN.
REDES_DOCKER=""
if [[ " $ROLES " == *" mon "* ]]; then
  for c in prometheus grafana; do
    for red in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" 2>/dev/null || true); do
      [[ "$red" == host ]] && continue
      REDES_DOCKER+=" $(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$red" 2>/dev/null || true)"
    done
  done
  REDES_DOCKER="$(tr ' ' '\n' <<<"$REDES_DOCKER" | grep -v '^$' | sort -u | tr '\n' ' ' || true)"
fi
puertos_docker="$(tr ' ' '\n' <<<"$puertos" | grep -vx '22' | tr '\n' ' ' || true)"

titulo "Firewall de $(hostname) — roles: $ROLES"
echo "  Entrada: todo cerrado, excepto"
echo "    desde $LAN (TCP): $puertos"
[[ -n "${REDES_DOCKER// /}" ]] && echo "    desde la red Docker de mon, $REDES_DOCKER(TCP): $puertos_docker"
(( ${#EXTRAS[@]} )) && echo "    desde cualquier origen (TCP): ${EXTRAS[*]}"
echo "  Salida: sin cambios (todo permitido)"

if (( ! APLICAR )); then
  echo
  info "No se cambió nada. Para aplicarlo: sudo bash scripts/interno/firewall.sh --aplicar${EXTRAS[*]:+ $(printf -- '--abrir %s ' "${EXTRAS[@]}")}"
  exit 0
fi

# ---------- Aplicar ----------
[[ $EUID -eq 0 ]] || falla "Para aplicar hace falta sudo: sudo bash scripts/interno/firewall.sh --aplicar ..."
command -v ufw >/dev/null || falla "ufw no está instalado: sudo apt install ufw"

info "Borrando las reglas anteriores de ufw (ufw guarda una copia en /etc/ufw/*.rules.<fecha>)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $puertos; do   # el 22 queda permitido antes de activar: no se corta el SSH
  ufw allow from "$LAN" to any port "$p" proto tcp comment 'ingdatos' >/dev/null
done
for red in $REDES_DOCKER; do
  for p in $puertos_docker; do
    ufw allow from "$red" to any port "$p" proto tcp comment 'ingdatos (red Docker de mon)' >/dev/null
  done
done
for p in "${EXTRAS[@]}"; do
  ufw allow "$p/tcp" comment 'ajeno al proyecto' >/dev/null
done
ufw --force enable >/dev/null
ufw status verbose
ok "Firewall activo en $(hostname). Revisa desde otra máquina: bash scripts/interno/verificar.sh y una compra de prueba."
