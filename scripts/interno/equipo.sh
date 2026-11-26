#!/usr/bin/env bash
# Acciones por máquina del laboratorio (D31). No se llama directo: cada máquina usa su atajo
#   bash scripts/db1.sh <acción>   laptop de Rogelio  → db1 + app   (192.168.1.102)
#   bash scripts/db2.sh <acción>   PC de escritorio   → db2 (+ mon) (192.168.1.105)
#   bash scripts/db3.sh <acción>   laptop de Many     → db3         (192.168.1.103)
#
# Para revisar y mostrar (no cambian nada):
#   estado            IP, hora, contenedores y primarios.
#   revisar           Replicación y conteos de las bases de ESTA máquina.
#   pedidos [n]       Últimos n pedidos (5) y su recorrido por los 3 motores.
#   fragmentacion     Demo de la fragmentación con lo que corre en ESTA máquina.
#
# Montaje y operación (en el orden de un montaje desde cero):
#   limpiar           Borra contenedores y datos de esta máquina (no imágenes ni secretos). Pide "si".
#   hora [fecha]      Con internet: hora automática. Sin internet: bash scripts/dbN.sh hora 'AAAA-MM-DD HH:MM:SS'
#   preparar          /etc/hosts (uni) y preflight de los roles de esta máquina.
#   levantar          docker compose up de sus roles y firewall con esos roles.
#   montar            Replicación y datos (fases 7 y 8) de esta máquina. Espera sola a las otras máquinas.
#   reiniciar         limpiar + preparar + levantar + montar.
#   app               (solo db1) Levanta la app, muestra primarios, compra de prueba y 100 compras.
#   compra            Una compra de prueba por la API (POST /compras) y su recorrido.
#   prueba            (solo db1) Carga de 2 minutos a 10 compras/s para las pruebas de falla.
#   falla <motor> [s] Detiene un motor de ESTA máquina, espera s segundos (60) y lo vuelve a arrancar.
#   acomodar          Primarios en su lugar y reengancha el PostgreSQL de esta máquina si quedó cercado.
#   apagar            (db1) Detiene la app antes de apagar las máquinas.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$RAIZ"

NOMBRE="${1:?Uso: bash scripts/db1.sh|db2.sh|db3.sh <acción>}"; shift
ACCION="${1:-ayuda}"; shift || true

case "$NOMBRE" in
  db1) ROL=db1; COMPOSE=(base db1); FW_ROLES="db1 app"; PREFLIGHT="db1 app"
         declare -A MOTORES=([mysql]=mysql-db1 [mongo]=mongo-shard-db1 [mongos]=mongos-app) ;;
  db2)  ROL=db2; COMPOSE=(base db2); FW_ROLES="";        PREFLIGHT="db2"
         declare -A MOTORES=([postgres]=postgres-db2 [mysql]=mysql-db2 [mongo]=mongo-shard-db2)
         # mon temporal en la PC mientras no lo lleve Diego o Vladimir (solo si ya tiene su .env)
         if [[ -f roles/mon/.env ]]; then COMPOSE+=(mon); PREFLIGHT="db2 mon"; fi ;;
  db3)  ROL=db3; COMPOSE=(base db3); FW_ROLES="db3";     PREFLIGHT="db3"
         declare -A MOTORES=([postgres]=postgres-db3 [mongo]=mongo-shard-db3 [mongos]=mongos-db3) ;;
  *) falla "Máquina desconocida: $NOMBRE (db1, db2 o db3)" ;;
esac

solo_roger() { [[ "$NOMBRE" == db1 ]] || falla "La acción '$ACCION' se corre en la laptop de Rogelio: bash scripts/db1.sh $ACCION"; }

# Compose de un rol, con el perfil standby en db3 (ahí vive PostgreSQL)
dc() { local r="$1"; shift; if [[ "$r" == db3 ]]; then (cd "roles/$r" && docker compose --profile standby "$@"); else (cd "roles/$r" && docker compose "$@"); fi; }

# Primarios según el vigilante, en una línea por nodo (sin jq: no está en todas las máquinas)
primarios() {
  local json
  json="$(curl -s -m 3 http://app:8090/estado || true)"
  [[ -n "$json" ]] || { aviso "El vigilante no responde en app:8090 (¿app detenida?)"; return 0; }
  python3 -c '
import json, sys
d = json.loads(sys.argv[1])
for m in ("mysql", "postgres"):
    for n, v in d[m]["nodos"].items():
        print("  %-9s %s: %s" % (m, n, v["rol"]))
' "$json"
}

estado() {
  titulo "Red ($NOMBRE)"; ip -4 -br addr | grep -vE '^(lo|docker|br-)' || true
  titulo "Hora"; date
  titulo "Contenedores del proyecto"
  docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E -- '-(db[0-9]|app)$|^node-exporter|^prometheus|^grafana' | sort || echo "  (ninguno)"
  titulo "Primarios (vigilante)"; primarios
}

limpiar() {
  read -rp "Se BORRAN los contenedores y datos de $NOMBRE (${COMPOSE[*]}$([[ $NOMBRE == db1 ]] && echo ' app')). Escribe si: " r
  [[ "$r" == "si" ]] || falla "Cancelado"
  [[ "$NOMBRE" == db1 ]] && dc app down -v
  local i; for ((i = ${#COMPOSE[@]} - 1; i >= 0; i--)); do dc "${COMPOSE[$i]}" down -v; done
  if docker ps -a --format '{{.Names}}' | grep -qE -- '-(db[0-9]|app)$'; then falla "Quedaron contenedores del proyecto: revisa docker ps -a"; fi
  ok "$NOMBRE limpia: sin contenedores ni datos del proyecto"
}

hora() {
  if [[ -n "${1:-}" ]]; then
    sudo timedatectl set-ntp false && sudo timedatectl set-time "$1"
  elif ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then
    sudo timedatectl set-ntp true; info "Con internet: hora automática (unos segundos en ajustarse)"; sleep 5
  else
    aviso "Sin internet: pásale la hora real → bash scripts/$NOMBRE.sh hora 'AAAA-MM-DD HH:MM:SS'"
  fi
  # La PC también arranca Windows, que guarda el reloj de la placa en hora local
  [[ "$NOMBRE" == db2 ]] && sudo timedatectl set-local-rtc 1 2>/dev/null
  date
}

preparar() {
  bash scripts/interno/aplicar-hosts.sh uni
  # shellcheck disable=SC2086
  bash scripts/interno/preflight.sh $PREFLIGHT
}

levantar() {
  local r; for r in "${COMPOSE[@]}"; do info "Levantando $r"; dc "$r" up -d; done
  # Con los roles explícitos: la app de db1 aún no está arriba. En db2 se detectan (db2 y mon).
  if [[ -n "$FW_ROLES" ]]; then sudo ROLES="$FW_ROLES" bash scripts/interno/firewall.sh --aplicar
  else sudo bash scripts/interno/firewall.sh --aplicar; fi
}

# Cuántos intentos de 2 s se espera a otra máquina: 15 minutos
ESPERA=450

montar() {
  cargar_secretos
  case "$NOMBRE" in
    db1)
      titulo "7.1 MySQL primario"; bash scripts/interno/mysql/init-primario.sh
      esperar "Mongo de db2 y db3 arriba" "$ESPERA" bash -c 'for h in db2 db3; do for p in 27018 27019; do exec 3<>/dev/tcp/$h/$p || exit 1; done; done'
      titulo "7.5 Replica sets de Mongo"; bash scripts/interno/mongo/init-replsets.sh
      titulo "8.1 Datos de MySQL"; bash scripts/interno/mysql/datos.sh
      ok "db1 listo. Cuando db2 y db3 digan listo: bash scripts/db1.sh app" ;;
    db2)
      export MYSQL_PWD="$MYSQL_REPL_PASSWORD"
      esperar "MySQL de db1 listo como primario (usuario de réplica)" "$ESPERA" \
        docker exec -e MYSQL_PWD mysql-db2 mysql --protocol=TCP -h db1 -P 3306 -urepl_mysql -e 'SELECT 1'
      unset MYSQL_PWD
      titulo "7.2 Réplica de MySQL"; bash scripts/interno/mysql/init-replica.sh
      titulo "7.3 PostgreSQL primario"; bash scripts/interno/postgres/init-primario.sh
      titulo "8.2 Datos de PostgreSQL"; bash scripts/interno/postgres/datos.sh
      ok "db2 listo" ;;
    db3)
      export PGPASSWORD="$PG_APP_PASSWORD"
      esperar "PostgreSQL de db2 listo como primario" "$ESPERA" \
        docker run --rm --network host -e PGPASSWORD postgres:16.6 psql -h db2 -U app_ecommerce -d ecommerce -tAc 'SELECT 1'
      unset PGPASSWORD
      titulo "7.4 Standby de PostgreSQL"; bash scripts/interno/postgres/init-standby.sh
      esperar "Replica sets de Mongo con primario (7.5 en db1)" "$ESPERA" bash -c '
        for c in "mongo-cfg-db3 27019" "mongo-shard-db3 27018"; do set -- $c
          docker exec "$1" mongosh --quiet --port "$2" -u admin -p "$MONGO_ADMIN_PASSWORD" \
            --authenticationDatabase admin --eval "quit(db.hello().primary ? 0 : 1)" || exit 1
        done'
      titulo "7.6 Sharding de Mongo"; bash scripts/interno/mongo/init-sharding.sh
      titulo "8.3 Datos de Mongo"; bash scripts/interno/mongo/datos.sh
      ok "db3 lista" ;;
  esac
}

app() {
  solo_roger
  dc app up -d
  esperar "vigilante responde" 30 curl -sf -m 2 localhost:8090/estado
  sleep 15
  titulo "Primarios (deben ser MySQL db1 y PostgreSQL db2)"; primarios
  titulo "Compra de prueba"; bash scripts/interno/probar-compra.sh 2>&1 | tail -6
  titulo "100 compras"; bash scripts/simular.sh --n 100
}

prueba() { solo_roger; bash scripts/simular.sh --tps 10 --minutos 2; }

tirar() {
  local motor="${1:-}" segundos="${2:-60}" c=""
  [[ -n "$motor" ]] && c="${MOTORES[$motor]:-}"
  [[ -n "$c" ]] || falla "Uso: bash scripts/$NOMBRE.sh falla <${!MOTORES[*]}> [segundos]"
  exigir_contenedor "$c"
  info "Deteniendo $c durante $segundos s"
  docker stop "$c" >/dev/null
  local i; for ((i = segundos; i > 0; i -= 5)); do printf '\r  vuelve en %3d s ' "$i"; sleep 5; done; echo
  docker start "$c" >/dev/null
  esperar "$c arriba otra vez" 15 contenedor_corriendo "$c"
  info "Revisa los primarios en un momento: bash scripts/$NOMBRE.sh estado"
}

acomodar() {
  bash scripts/interno/primarios-en-su-lugar.sh --si || true
  # PostgreSQL de esta máquina cercado (primario que volvió de una caída brusca): se reengancha
  [[ -n "${MOTORES[postgres]:-}" ]] || return 0
  local json rol prim
  json="$(curl -s -m 3 http://app:8090/estado || true)"
  [[ -n "$json" ]] || return 0
  read -r rol prim < <(python3 -c '
import json, sys
d = json.loads(sys.argv[1])["postgres"]
print(d["nodos"].get(sys.argv[2], {}).get("rol", "?"), d.get("primario") or "-")
' "$json" "$ROL")
  if [[ "$rol" == "CERCADO" ]]; then
    aviso "El PostgreSQL de $ROL está cercado; el primario es $prim. Se reengancha con rejoin.sh $prim"
    bash scripts/interno/postgres/rejoin.sh "$prim"
  else
    ok "PostgreSQL de $ROL: $rol"
  fi
}

apagar() {
  if [[ "$NOMBRE" == db1 ]]; then dc app stop; ok "App detenida: ya puedes apagar las tres máquinas (la tuya al final)"
  else info "En $NOMBRE no hay nada que detener: apágala cuando db1 haya corrido 'bash scripts/db1.sh apagar'"; fi
}

case "$ACCION" in
  estado)    estado ;;
  revisar)   bash scripts/interno/verificar.sh; titulo "Conteos"; bash scripts/interno/conteos.sh ;;
  pedidos)   bash scripts/interno/ultimos.sh "$@" ;;
  fragmentacion) bash scripts/interno/demo-fragmentacion.sh ;;
  compra)    bash scripts/interno/probar-compra.sh; bash scripts/interno/ultimos.sh 1 ;;
  limpiar)   limpiar ;;
  hora)      hora "${1:-}" ;;
  preparar)  preparar ;;
  levantar)  levantar ;;
  montar)    montar ;;
  reiniciar) limpiar; preparar; levantar; montar ;;
  app)       app ;;
  prueba)    prueba ;;
  falla)     tirar "${1:-}" "${2:-60}" ;;
  acomodar)  acomodar ;;
  apagar)    apagar ;;
  ayuda|-h|--ayuda) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" ;;
  *) falla "Acción desconocida: $ACCION. Ayuda: bash scripts/$NOMBRE.sh ayuda" ;;
esac
