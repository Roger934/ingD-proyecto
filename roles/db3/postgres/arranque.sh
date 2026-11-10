#!/usr/bin/env bash
# Arranque de PostgreSQL (D27). Igual en db2 y db3. Lo usa el docker-compose como entrypoint.
#  1. Escribe ~postgres/.pgpass con la contraseña de repl_pg: así primary_conninfo no lleva la contraseña.
#  2. Si la base ya existe, crea standby.signal: TODO nodo arranca como standby, nunca como primario.
#     El vigilante (rol app) decide quién es el primario y lo promueve. Así un primario caído que
#     regresa no puede aceptar escrituras por su cuenta (sin split brain).
#     La primera vez (volumen vacío) no hay PG_VERSION: initdb crea un primario normal.
set -e
PGHOME=/var/lib/postgresql
printf '*:*:*:repl_pg:%s\n' "${PG_REPL_PASSWORD:?Falta PG_REPL_PASSWORD}" > "$PGHOME/.pgpass"
chown postgres:postgres "$PGHOME/.pgpass"
chmod 600 "$PGHOME/.pgpass"

if [ -s "$PGDATA/PG_VERSION" ]; then
  touch "$PGDATA/standby.signal"
  chown postgres:postgres "$PGDATA/standby.signal"
  echo "arranque.sh: la base ya existe → arranca como STANDBY; el vigilante decide quién es el primario"
fi
exec docker-entrypoint.sh "$@"
