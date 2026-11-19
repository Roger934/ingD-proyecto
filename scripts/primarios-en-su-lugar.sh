#!/usr/bin/env bash
# Deja los primarios en su lugar antes de la demo: MySQL db1, PostgreSQL db2, Mongo db1.
# Después de las pruebas de falla los primarios quedan donde los dejó el último failover.
#
# No promueve nada por su cuenta: el único que nombra primarios es el vigilante (D27). Lo que hace es
# una "falla controlada", el mismo camino que ya se probó: apaga limpio el primario que está fuera de
# lugar, espera a que el vigilante promueva al otro nodo y lo vuelve a encender como réplica.
# Cada motor se queda unos 10 s sin primario: correr SIN carga (sin simulador).
#
#   bash scripts/primarios-en-su-lugar.sh         → revisa y, si hace falta, pregunta antes de mover
#   bash scripts/primarios-en-su-lugar.sh --si    → no pregunta (para correrlo por ssh)
#
# Se puede correr en cualquier máquina. Solo mueve un primario si su contenedor está EN ESTA máquina;
# si está en otra, dice en cuál hay que correrlo. Mongo se revisa desde cualquiera que tenga un
# contenedor de Mongo (db1 recupera el puesto solo, por su prioridad 2).
# Otros destinos: PRIMARIO_MYSQL=db2 PRIMARIO_PG=db3 PRIMARIO_MONGO=db1 bash scripts/primarios-en-su-lugar.sh
set -uo pipefail
source "$(dirname "$0")/lib.sh"

VIGILANTE="${VIGILANTE:-http://app:8090}"
declare -A DESEADO=([mysql]="${PRIMARIO_MYSQL:-db1}" [postgres]="${PRIMARIO_PG:-db2}")
DESEADO_MONGO="${PRIMARIO_MONGO:-db1}"
SI=0
case "${1:-}" in
  "") ;;
  --si) SI=1 ;;
  *) falla "Uso: bash scripts/primarios-en-su-lugar.sh [--si]" ;;
esac

# ---------- Vigilante ----------
metricas() { curl -s -f -m 5 "$VIGILANTE/metrics"; }
primario_de() {  # primario_de <motor> → db1 | db2 | db3 | (vacío si no hay)
  metricas | sed -n "s/^vigilante_es_primario{motor=\"$1\",nodo=\"\([a-z0-9]*\)\"} 1\$/\1/p" | head -1
}
es_primario() { [[ "$(primario_de "$1")" == "$2" ]]; }
alcanzable() { metricas | grep -q "^vigilante_nodo_alcanzable{motor=\"$1\",nodo=\"$2\"} 1\$"; }

confirmar() {
  (( SI )) && return 0
  local r
  read -rp "$1 Escribe si: " r
  [[ "$r" == "si" ]]
}

# esperar_a "descripción" segundos comando...  → 0 si el comando se cumple a tiempo, 1 si no (no termina el script)
esperar_a() {
  local desc="$1" seg="$2"; shift 2
  info "Esperando: $desc (máximo $seg s)"
  local fin=$((SECONDS + seg))
  while (( SECONDS < fin )); do
    if "$@" >/dev/null 2>&1; then ok "$desc"; return 0; fi
    sleep 2
  done
  return 1
}

# ---------- Revisiones por motor (sobre el contenedor local $C) ----------
mysql_local() { docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot -N "$@"; }
# Consulta a otro MySQL con el usuario del vigilante; la contraseña viaja por variable de entorno.
mysql_en() {  # mysql_en <host> <sql>
  docker exec -i -e MYSQL_FAILOVER_PASSWORD "$C" sh -c \
    'MYSQL_PWD="$MYSQL_FAILOVER_PASSWORD" exec mysql -h "$0" -ufailover_mysql -N -e "$1"' "$1" "$2"
}
pg_local() { docker exec -u postgres "$C" psql -d ecommerce -Atc "$1"; }

# ¿El otro nodo ya tiene todo lo que tiene este primario? Si no, apagarlo perdería datos.
replica_al_dia() {  # replica_al_dia <motor> <destino>
  if [[ "$1" == mysql ]]; then
    local gtid
    gtid=$(mysql_local -e "SELECT REPLACE(@@global.gtid_executed, '\n', '')") || return 1
    [[ "$(mysql_en "$2" "SELECT GTID_SUBSET('$gtid', @@global.gtid_executed)")" == "1" ]]
  else
    [[ "$(pg_local "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'
                    AND pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) = 0")" -ge 1 ]]
  fi
}

# ¿Este nodo ya volvió como réplica del nuevo primario?
sigue_a() {  # sigue_a <motor> <primario>
  if [[ "$1" == mysql ]]; then
    [[ "$(mysql_local -e "SELECT @@global.read_only, COUNT(*) FROM performance_schema.replication_connection_configuration c
          JOIN performance_schema.replication_connection_status s USING (CHANNEL_NAME)
          WHERE c.HOST = '$2' AND s.SERVICE_STATE = 'ON'" | tr -s '\t ' ' ')" == "1 1" ]]
  else
    [[ "$(pg_local "SELECT count(*) FROM pg_stat_wal_receiver WHERE status = 'streaming' AND sender_host = '$2'")" == "1" ]]
  fi
}

# ---------- Falla controlada: este nodo cede el puesto ----------
ceder() {  # ceder <motor> <actual> <deseado>   (usa $C = contenedor local del primario actual)
  local motor="$1" actual="$2" deseado="$3"

  alcanzable "$motor" "$deseado" || { aviso "El vigilante no alcanza a $motor en $deseado: no hay a quién ceder el puesto."; return 1; }
  if [[ "$motor" == mysql ]]; then
    cargar_secretos
    export MYSQL_PWD="$MYSQL_ROOT_PASSWORD" MYSQL_FAILOVER_PASSWORD
  fi
  if ! replica_al_dia "$motor" "$deseado"; then
    sleep 3   # una segunda oportunidad: la réplica puede ir unos milisegundos atrás
    replica_al_dia "$motor" "$deseado" || { aviso "$deseado no está al día con $actual (¿hay carga o la réplica está detenida?). No muevo $motor. Revisa: bash scripts/verificar.sh"; return 1; }
  fi
  ok "$deseado tiene todos los datos de $actual"

  confirmar "¿Apagar $C unos segundos para que $deseado quede como primario de $motor?" || { aviso "Cancelado: $motor se queda en $actual"; return 1; }

  info "Apagando $C (apagado limpio)"
  docker stop -t 60 "$C" >/dev/null || { aviso "No pude apagar $C"; return 1; }

  if ! esperar_a "el vigilante promueve a $deseado" 60 es_primario "$motor" "$deseado"; then
    docker start "$C" >/dev/null
    aviso "El vigilante no promovió a $deseado. Volví a encender $C; revisa: curl -s $VIGILANTE/estado"
    return 1
  fi

  info "Encendiendo $C: debe volver como réplica de $deseado"
  docker start "$C" >/dev/null || { aviso "No pude encender $C"; return 1; }
  if esperar_a "$C sigue a $deseado" 90 sigue_a "$motor" "$deseado"; then
    ok "$motor: primario $deseado, réplica $actual"
  else
    local rejoin="bash scripts/$motor/rejoin.sh $deseado"
    aviso "$C encendió pero todavía no sigue a $deseado. Revisa curl -s $VIGILANTE/estado; si no se arregla solo, aquí: $rejoin"
    return 1
  fi
}

# ---------- MySQL y PostgreSQL ----------
metricas >/dev/null || falla "No alcanzo al vigilante en $VIGILANTE. ¿Está arriba el rol app? (docker ps en la máquina app)"

pendientes=0
for motor in mysql postgres; do
  deseado="${DESEADO[$motor]}"
  titulo "$motor (debe estar en $deseado)"
  actual="$(primario_de "$motor")"
  if [[ -z "$actual" ]]; then
    aviso "$motor no tiene primario en este momento. No toco nada: revisa curl -s $VIGILANTE/estado"
    pendientes=$((pendientes + 1))
  elif [[ "$actual" == "$deseado" ]]; then
    ok "$motor ya tiene su primario en $deseado"
  else
    C="$motor-$actual"
    if contenedor_corriendo "$C"; then
      info "El primario está en $actual (esta máquina) y debe estar en $deseado"
      ceder "$motor" "$actual" "$deseado" || pendientes=$((pendientes + 1))
    else
      aviso "El primario está en $actual y debe estar en $deseado. Corre este mismo script en la máquina con el rol $actual."
      pendientes=$((pendientes + 1))
    fi
  fi
done

# ---------- MongoDB ----------
titulo "mongo (debe estar en $DESEADO_MONGO)"
# Se prefiere el shard (siempre corre), luego el config server y al final un mongos.
nombres_mongo="$(docker ps --format '{{.Names}}')"
CM="$(for pre in mongo-shard mongo-cfg mongos; do grep -m1 "^$pre-" <<<"$nombres_mongo"; done | head -1 || true)"
if [[ -z "$CM" ]]; then
  aviso "Esta máquina no tiene contenedores de Mongo: no puedo revisarlo desde aquí. Córrelo en db1, db2, db3 o app."
  pendientes=$((pendientes + 1))
else
  primario_mongo() {  # primario_mongo <puerto> → "db1:27018" (pregunta a cualquier miembro que responda)
    local h p
    for h in db1 db2 db3; do
      p=$(docker exec "$CM" mongosh --quiet --host "$h" --port "$1" --eval 'print(db.hello().primary || "")' 2>/dev/null | tail -1)
      # Solo vale una respuesta como "db1:27018": un error de docker exec no se toma por primario.
      [[ "$p" =~ ^db[0-9]:[0-9]+$ ]] && { echo "$p"; return 0; }
    done
    return 1
  }
  en_su_lugar_mongo() { [[ "$(primario_mongo "$1")" == "$DESEADO_MONGO:$1" ]]; }

  for par in shardA:27018 cfgRS:27019; do
    rs="${par%%:*}"; puerto="${par##*:}"
    if en_su_lugar_mongo "$puerto"; then ok "$rs ya tiene su primario en $DESEADO_MONGO"; continue; fi
    actual="$(primario_mongo "$puerto" || true)"
    if [[ -z "$actual" ]]; then
      aviso "$rs no tiene primario en este momento (¿hay mayoría de miembros arriba?)"
      pendientes=$((pendientes + 1)); continue
    fi
    info "$rs tiene su primario en ${actual%%:*}. $DESEADO_MONGO debería recuperarlo solo (prioridad 2)"
    if esperar_a "$rs vuelve a $DESEADO_MONGO" 30 en_su_lugar_mongo "$puerto"; then continue; fi
    if confirmar "¿Pedirle a ${actual%%:*} que deje de ser primario de $rs (rs.stepDown)?"; then
      cargar_secretos
      export MONGO_ADMIN_PASSWORD
      # stepDown cierra la conexión: el error de red al final es normal
      docker exec -e MONGO_ADMIN_PASSWORD "$CM" mongosh --quiet --host "${actual%%:*}" --port "$puerto" --eval \
        "db.getSiblingDB('admin').auth('admin', process.env.MONGO_ADMIN_PASSWORD); rs.stepDown(60)" >/dev/null 2>&1 || true
      esperar_a "$rs vuelve a $DESEADO_MONGO" 40 en_su_lugar_mongo "$puerto" && continue
    fi
    aviso "$rs sigue con su primario en ${actual%%:*}. Revisa en $DESEADO_MONGO: bash scripts/verificar.sh"
    pendientes=$((pendientes + 1))
  done
fi

echo
if (( pendientes == 0 )); then
  ok "Todos los primarios están en su lugar: MySQL ${DESEADO[mysql]}, PostgreSQL ${DESEADO[postgres]}, Mongo $DESEADO_MONGO"
else
  falla "Pendientes por acomodar: $pendientes (ver los avisos de arriba)"
fi
