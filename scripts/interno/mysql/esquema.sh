#!/usr/bin/env bash
# Se corre en db1 (primario). Crea las 5 tablas y la vista pedido_completo (db/mysql/schema.sql).
# La réplica las recibe sola por replicación. Idempotente.
#   bash scripts/interno/mysql/esquema.sh               → crea lo que falte
#   bash scripts/interno/mysql/esquema.sh --reiniciar   → BORRA las tablas y sus datos, y las vuelve a crear
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos

C=mysql-db1
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"
exigir_contenedor "$C"
[[ "$(docker exec -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot -N -e 'SELECT @@global.read_only')" == "0" ]] \
  || falla "Este MySQL está en solo lectura (es réplica). El esquema se aplica en el primario."

if [[ "${1:-}" == "--reiniciar" ]]; then
  aviso "Borrando las tablas de ecommerce en MySQL (y sus datos)"
  docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot ecommerce <<'SQL'
DROP VIEW IF EXISTS pedido_completo;
DROP TABLE IF EXISTS detalle_pedido, pedido_cliente, pedidos, direcciones, clientes;
SQL
fi

info "Aplicando db/mysql/schema.sql"
docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot ecommerce < "$RAIZ/db/mysql/schema.sql"

docker exec -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot -t -e \
  "SELECT table_name AS tabla, table_type AS tipo, table_rows AS filas_aprox FROM information_schema.tables WHERE table_schema = 'ecommerce' ORDER BY table_type, table_name;"
ok "Esquema de MySQL listo (5 tablas + vista pedido_completo)"
