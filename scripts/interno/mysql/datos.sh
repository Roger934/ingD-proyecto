#!/usr/bin/env bash
# Se corre en db1 (primario). Carga los seeds de MySQL (~73k filas); la réplica los recibe sola.
#   bash scripts/interno/mysql/datos.sh               → crea el esquema si falta y carga (las tablas deben estar vacías)
#   bash scripts/interno/mysql/datos.sh --reiniciar   → BORRA las tablas y todo lo que tengan, y carga de nuevo
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos

C=mysql-db1
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"
exigir_contenedor "$C"
bash "$RAIZ/scripts/interno/generar-datos.sh"
bash "$RAIZ/scripts/interno/mysql/esquema.sh" ${1:+"$1"}

hay=$(docker exec -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot -N ecommerce -e "SELECT COUNT(*) FROM clientes")
[[ "$hay" == "0" ]] || falla "La tabla clientes ya tiene $hay filas. Para borrar todo y cargar de nuevo: bash scripts/interno/mysql/datos.sh --reiniciar"

info "Cargando seed/datos/mysql.sql (tarda menos de un minuto)"
inicio=$SECONDS
docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot ecommerce < "$RAIZ/seed/datos/mysql.sql"
ok "Carga terminada en $((SECONDS - inicio)) s"

bash "$RAIZ/scripts/interno/conteos.sh" mysql
