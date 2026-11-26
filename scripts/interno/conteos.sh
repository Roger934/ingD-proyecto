#!/usr/bin/env bash
# Cuenta registros por tabla/colección en los motores que corren EN ESTA máquina.
# Sirve para ver que los datos llegaron a las réplicas: en db2 muestra la réplica de MySQL, en db3 el standby.
#   bash scripts/interno/conteos.sh                 → todos los motores locales
#   bash scripts/interno/conteos.sh mysql|postgres|mongo
set -uo pipefail
source "$(dirname "$0")/lib.sh"
cargar_secretos
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD" MONGO_ADMIN_PASSWORD
solo="${1:-}"

locales=$(docker ps --format '{{.Names}}')
mongos_local=$(grep -m1 '^mongos-' <<<"$locales" || true)

for c in $locales; do
  case "$c" in
    mysql-*)
      [[ -z $solo || $solo == mysql ]] || continue
      titulo "MySQL ($c) — $(docker exec -e MYSQL_PWD "$c" mysql --default-character-set=utf8mb4 -uroot -N -e 'SELECT IF(@@read_only, "réplica", "primario")')"
      docker exec -e MYSQL_PWD "$c" mysql --default-character-set=utf8mb4 -uroot -t ecommerce -e "
        SELECT 'clientes' AS tabla, COUNT(*) AS registros FROM clientes
        UNION ALL SELECT 'direcciones', COUNT(*) FROM direcciones
        UNION ALL SELECT 'pedidos', COUNT(*) FROM pedidos
        UNION ALL SELECT 'pedido_cliente', COUNT(*) FROM pedido_cliente
        UNION ALL SELECT 'detalle_pedido', COUNT(*) FROM detalle_pedido
        UNION ALL SELECT 'TOTAL', (SELECT COUNT(*) FROM clientes) + (SELECT COUNT(*) FROM direcciones) + (SELECT COUNT(*) FROM pedidos)
                              + (SELECT COUNT(*) FROM pedido_cliente) + (SELECT COUNT(*) FROM detalle_pedido);"
      ;;
    postgres-db*)
      [[ -z $solo || $solo == postgres ]] || continue
      titulo "PostgreSQL ($c) — $(docker exec -u postgres "$c" psql -Atc "SELECT CASE WHEN pg_is_in_recovery() THEN 'standby' ELSE 'primario' END")"
      docker exec -u postgres "$c" psql -d ecommerce -c "
        SELECT tabla, registros FROM (
          SELECT 1 o, 'sucursales' tabla, count(*) registros FROM sucursales
          UNION ALL SELECT 2, 'productos_sucursal', count(*) FROM productos_sucursal
          UNION ALL SELECT 3, 'inventario', count(*) FROM inventario
          UNION ALL SELECT 4, 'reservas', count(*) FROM reservas
          UNION ALL SELECT 5, 'movimientos', count(*) FROM movimientos) t
        UNION ALL SELECT 'TOTAL', (SELECT count(*) FROM sucursales) + (SELECT count(*) FROM productos_sucursal) + (SELECT count(*) FROM inventario)
                                + (SELECT count(*) FROM reservas) + (SELECT count(*) FROM movimientos);"
      docker exec -u postgres "$c" psql -d ecommerce -c "
        SELECT tableoid::regclass AS fragmento, count(*) AS filas FROM inventario GROUP BY 1 ORDER BY 1;"
      ;;
  esac
done

if [[ -n $mongos_local && ( -z $solo || $solo == mongo ) ]]; then
  titulo "MongoDB (vía $mongos_local)"
  docker exec -i -e MONGO_ADMIN_PASSWORD "$mongos_local" mongosh --quiet --port 27017 --eval "
    db.getSiblingDB('admin').auth('admin', process.env.MONGO_ADMIN_PASSWORD);
    const e = db.getSiblingDB('ecommerce');
    let total = 0;
    for (const c of ['catalogo', 'resenas', 'carritos', 'logs_busqueda', 'eventos']) {
      const n = e.getCollection(c).countDocuments({});
      total += n;
      print('  ' + c.padEnd(14) + String(n).padStart(8));
    }
    print('  ' + 'TOTAL'.padEnd(14) + String(total).padStart(8));
    print('');
    print('Reparto de catalogo y eventos por shard:');
    for (const c of ['catalogo', 'eventos']) {
      e.getCollection(c).aggregate([{ \$collStats: { count: {} } }]).forEach(s => print('  ' + c.padEnd(10) + s.shard.padEnd(8) + s.count));
    }"
fi
echo
