#!/usr/bin/env bash
# Revisa que una máquina esté lista para sus roles. No cambia nada salvo permisos de los .cnf.
# Uso:  bash scripts/preflight.sh db1 app mon      (los roles que tendrá esta máquina)
set -uo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# -gt 0 ]] || falla "Uso: bash scripts/preflight.sh <rol> [rol...]   (db1 db2 db3 app mon)"
ROLES_MAQUINA=("$@")
problemas=0
mal() { printf '\033[31m✘\033[0m %s\n' "$*"; problemas=$((problemas + 1)); }

declare -A PUERTOS=(
  [base]="9100"
  [db1]="3306 9104 27019 27018 9216"
  [db2]="3306 9104 5432 9187 27019 27018 9216"
  [db3]="5432 9187 27019 27018 27017 9216"
  [app]="27017 8080"
  [mon]="9090 3000"
)

titulo "Docker"
if command -v docker >/dev/null; then ok "$(docker --version)"; else mal "Docker no está instalado"; fi
if docker compose version >/dev/null 2>&1; then ok "$(docker compose version)"; else mal "Falta el plugin docker compose"; fi
if docker ps >/dev/null 2>&1; then ok "El usuario puede usar Docker sin sudo"; else mal "Tu usuario no puede usar Docker: sudo usermod -aG docker \$USER y vuelve a entrar"; fi

titulo "CPU y memoria"
necesita_mongo=0
for r in "${ROLES_MAQUINA[@]}"; do [[ $r =~ ^(db1|db2|db3|app)$ ]] && necesita_mongo=1; done
if [[ $necesita_mongo == 1 ]]; then
  if grep -qw avx /proc/cpuinfo; then ok "La CPU tiene AVX (MongoDB 7 lo necesita)"
  else mal "La CPU no expone AVX: MongoDB 7 no arrancará. En VirtualBox, apaga Hyper-V/WSL2 en Windows o revisa la config de la VM"; fi
fi
disp=$(awk '/MemAvailable/ {printf "%.1f", $2/1048576}' /proc/meminfo)
ok "RAM disponible ahora: ${disp} GiB"

titulo "Nombres de rol (/etc/hosts)"
for r in db1 db2 db3 app mon; do
  ip=$(getent hosts "$r" | awk '{print $1; exit}')
  if [[ -z $ip ]]; then mal "'$r' no resuelve. Corre: bash scripts/aplicar-hosts.sh casa"
  elif [[ $ip == 127.* ]]; then mal "'$r' resuelve a $ip (loopback): rompe la replicación"
  else ok "$r → $ip"; fi
done

titulo "Secretos"
if [[ -f $SECRETOS_ENV && -f $SECRETOS_KEYFILE ]]; then ok "secretos/ingdatos.env y secretos/mongo-keyfile presentes"
else mal "Faltan secretos/: corre bash scripts/generar-secretos.sh en UNA máquina y copia el repo"; fi
for r in "${ROLES_MAQUINA[@]}"; do
  [[ $r =~ ^(db1|db2|db3|app)$ && ! -f $RAIZ/roles/$r/.env ]] && mal "Falta roles/$r/.env (lo crea generar-secretos.sh)"
  [[ $r == mon && ! -f $RAIZ/roles/mon/.env ]] && mal "Falta roles/mon/.env (cp .env.example .env)"
done
# MySQL ignora archivos de configuración con permiso de escritura para todos
find "$RAIZ/roles" -name '*.cnf' -exec chmod 644 {} + 2>/dev/null && ok "Permisos 644 en los .cnf de MySQL"

titulo "Puertos"
nuestros=$(docker ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
for r in base "${ROLES_MAQUINA[@]}"; do
  for p in ${PUERTOS[$r]:-}; do
    if ss -ltnH "( sport = :$p )" 2>/dev/null | grep -q .; then
      if [[ -n $nuestros ]]; then ok "$p en uso (probablemente por nuestros contenedores: $nuestros)"
      else mal "El puerto $p ($r) ya está ocupado por otro programa"; fi
    else ok "$p libre ($r)"; fi
  done
done

titulo "Hora"
if timedatectl 2>/dev/null | grep -qi 'synchronized: yes'; then ok "Reloj sincronizado"; else aviso "El reloj no está sincronizado (timedatectl)"; fi

echo
if [[ $problemas -eq 0 ]]; then ok "Todo listo para: ${ROLES_MAQUINA[*]}"; else falla "$problemas problema(s) por resolver"; fi
