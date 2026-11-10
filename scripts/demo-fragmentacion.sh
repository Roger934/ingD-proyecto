#!/usr/bin/env bash
# Demo de la fragmentación (Plan, sección 7, paso 2). Corre lo que haya EN ESTA máquina:
#   MySQL      → la entidad Pedido se reconstruye con JOIN de sus dos fragmentos (vertical)
#   PostgreSQL → EXPLAIN muestra que solo se lee la partición de la sucursal (horizontal, pruning)
#   mongos     → reparto de chunks de catalogo y eventos (sharding)
set -uo pipefail
source "$(dirname "$0")/lib.sh"
cargar_secretos
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD" MONGO_ADMIN_PASSWORD
locales=$(docker ps --format '{{.Names}}')

for c in $locales; do
  case "$c" in
    mysql-*)
      titulo "MySQL ($c): fragmentación vertical de Pedido"
      echo "Fragmento 1 (pedidos) y fragmento 2 (pedido_cliente) del pedido 1:"
      docker exec -e MYSQL_PWD "$c" mysql -uroot -t ecommerce -e "
        SELECT * FROM pedidos WHERE id = 1;
        SELECT * FROM pedido_cliente WHERE pedido_id = 1;"
      echo "Reconstrucción: pedidos ⋈ pedido_cliente por la misma PK (vista pedido_completo):"
      docker exec -e MYSQL_PWD "$c" mysql -uroot -t ecommerce -e "
        SELECT p.id, p.cliente_id, p.total, p.estado, pc.destinatario, pc.ciudad, pc.cp
        FROM pedidos p JOIN pedido_cliente pc ON pc.pedido_id = p.id WHERE p.id = 1;
        SELECT (SELECT COUNT(*) FROM pedidos) AS pedidos, (SELECT COUNT(*) FROM pedido_cliente) AS pedido_cliente,
               (SELECT COUNT(*) FROM pedido_completo) AS reconstruidos;"
      ;;
    postgres-db*)
      titulo "PostgreSQL ($c): fragmentación horizontal por sucursal"
      docker exec -u postgres "$c" psql -d ecommerce -c "
        SELECT tableoid::regclass AS fragmento, count(*) AS filas, sum(cantidad) AS unidades FROM inventario GROUP BY 1 ORDER BY 1;"
      echo "EXPLAIN de una consulta de la sucursal 3: solo aparece inventario_s3 (partition pruning):"
      docker exec -u postgres "$c" psql -d ecommerce -c \
        "EXPLAIN (COSTS OFF) SELECT * FROM inventario WHERE sucursal_id = 3 AND producto_id = 10;"
      echo "Sin filtrar por sucursal se leen los 5 fragmentos:"
      docker exec -u postgres "$c" psql -d ecommerce -c \
        "EXPLAIN (COSTS OFF) SELECT * FROM inventario WHERE producto_id = 10;"
      ;;
    mongos-*)
      [[ -z "${mongo_hecho:-}" ]] || continue   # con un mongos basta
      mongo_hecho=1
      titulo "MongoDB ($c): sharding"
      docker exec -i -e MONGO_ADMIN_PASSWORD "$c" mongosh --quiet --port 27017 --eval "
        db.getSiblingDB('admin').auth('admin', process.env.MONGO_ADMIN_PASSWORD);
        const cfg = db.getSiblingDB('config');
        for (const ns of ['ecommerce.catalogo', 'ecommerce.eventos']) {
          const col = cfg.collections.findOne({ _id: ns });
          if (!col) { print(ns + ': no está fragmentada'); continue; }
          print(ns + '  llave ' + JSON.stringify(col.key));
          cfg.chunks.aggregate([{ \$match: { uuid: col.uuid } }, { \$group: { _id: '\$shard', chunks: { \$sum: 1 } } }])
            .forEach(g => print('  ' + g._id + ': ' + g.chunks + ' chunks'));
        }
        print('');
        print('Plan de una búsqueda por shard key (va a un solo shard):');
        const p = db.getSiblingDB('ecommerce').eventos.find({ pedido_id: 1 }).explain().queryPlanner.winningPlan;
        print('  ' + (p.stage || '') + ' → ' + JSON.stringify((p.shards || []).map(s => s.shardName)));"
      ;;
  esac
done
echo
