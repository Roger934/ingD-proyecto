#!/usr/bin/env bash
# Genera UNA vez las contraseñas y el keyFile de Mongo, y copia el .env a cada rol.
# Se corre en una sola máquina (por ejemplo, en Windows con Git Bash) y luego se copia el repo a las demás.
#   bash scripts/generar-secretos.sh            → genera si no existen; siempre recopia el .env a los roles
#   bash scripts/generar-secretos.sh --forzar   → regenera (¡rompe un clúster ya inicializado!)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

command -v openssl >/dev/null || falla "Se necesita openssl (Git Bash y Linux ya lo traen)."
mkdir -p "$RAIZ/secretos"

if [[ -f "$SECRETOS_ENV" && "${1:-}" != "--forzar" ]]; then
  info "Ya existen secretos en secretos/. No se regeneran (usa --forzar si de verdad quieres)."
else
  [[ "${1:-}" == "--forzar" ]] && aviso "Regenerando secretos: habrá que reinicializar los 3 motores."
  gen() { openssl rand -hex 16; }   # solo [0-9a-f]: sin problemas de escape en URIs ni SQL
  cat > "$SECRETOS_ENV" <<EOF
# Generado por scripts/generar-secretos.sh el $(date +%F).
# NO subir al repo. NO copiar a la bóveda de Obsidian.

# MySQL
MYSQL_ROOT_PASSWORD=$(gen)
MYSQL_REPL_PASSWORD=$(gen)
MYSQL_EXPORTER_PASSWORD=$(gen)
MYSQL_APP_PASSWORD=$(gen)

# PostgreSQL
POSTGRES_PASSWORD=$(gen)
PG_REPL_PASSWORD=$(gen)
PG_EXPORTER_PASSWORD=$(gen)
PG_APP_PASSWORD=$(gen)

# MongoDB
MONGO_ADMIN_PASSWORD=$(gen)
MONGO_EXPORTER_PASSWORD=$(gen)
MONGO_APP_PASSWORD=$(gen)
EOF
  # keyFile: autenticación interna entre miembros de Mongo (debe ser idéntico en todos)
  openssl rand -base64 756 | tr -d '\r' > "$SECRETOS_KEYFILE"
  ok "Secretos generados en secretos/ (no se muestran)."
fi

for rol in db1 db2 db3 app; do
  cp "$SECRETOS_ENV" "$RAIZ/roles/$rol/.env"
done
ok "Copiado el .env a roles/db1, db2, db3 y app."
