#!/usr/bin/env bash
# Se corre en db1, con su rol ya levantado. Crea la base y los usuarios por función.
# Idempotente: se puede repetir sin romper nada.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
cargar_secretos

C=mysql-db1
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"   # se pasa con "-e MYSQL_PWD", sin escribirla en la línea de comandos
exigir_contenedor "$C"
# Por TCP: el servidor temporal de inicialización no escucha en red, así que esto espera al definitivo.
esperar "MySQL listo en db1" 90 docker exec "$C" mysqladmin --protocol=TCP -h127.0.0.1 -P3306 ping

info "Creando base 'ecommerce' y usuarios (repl, exporter, app)"
docker exec -i -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot <<SQL
CREATE DATABASE IF NOT EXISTS ecommerce CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'repl_mysql'@'192.168.1.%' IDENTIFIED BY '${MYSQL_REPL_PASSWORD}';
ALTER USER 'repl_mysql'@'192.168.1.%' IDENTIFIED BY '${MYSQL_REPL_PASSWORD}';
GRANT REPLICATION SLAVE ON *.* TO 'repl_mysql'@'192.168.1.%';

CREATE USER IF NOT EXISTS 'exporter_mysql'@'127.0.0.1' IDENTIFIED BY '${MYSQL_EXPORTER_PASSWORD}' WITH MAX_USER_CONNECTIONS 3;
ALTER USER 'exporter_mysql'@'127.0.0.1' IDENTIFIED BY '${MYSQL_EXPORTER_PASSWORD}';
GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'exporter_mysql'@'127.0.0.1';
GRANT SELECT ON performance_schema.* TO 'exporter_mysql'@'127.0.0.1';

CREATE USER IF NOT EXISTS 'app_ecommerce'@'192.168.1.%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
ALTER USER 'app_ecommerce'@'192.168.1.%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON ecommerce.* TO 'app_ecommerce'@'192.168.1.%';
SQL

docker exec -e MYSQL_PWD "$C" mysql --default-character-set=utf8mb4 -uroot -t -e \
  "SELECT @@server_id AS server_id, @@gtid_mode AS gtid_mode, @@read_only AS read_only; SHOW BINARY LOG STATUS;"
ok "db1 listo como primario. Sigue: en db2, bash scripts/mysql/init-replica.sh"
