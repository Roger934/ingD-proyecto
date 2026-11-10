#!/usr/bin/env bash
# Genera las contraseñas y el keyFile de Mongo, y copia el .env a cada rol.
# Se corre en UNA máquina (por ejemplo, en Windows con Git Bash) y luego se copia secretos/ a las demás.
#   bash scripts/generar-secretos.sh            → crea lo que falte (incluye valores vacíos) sin tocar lo existente;
#                                                  siempre recopia el .env a los roles
#   bash scripts/generar-secretos.sh --forzar   → regenera TODO (¡rompe un clúster ya inicializado!)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

command -v openssl >/dev/null || falla "Se necesita openssl (Git Bash y Linux ya lo traen)."
mkdir -p "$RAIZ/secretos"

CLAVES=(
  MYSQL_ROOT_PASSWORD MYSQL_REPL_PASSWORD MYSQL_EXPORTER_PASSWORD MYSQL_APP_PASSWORD
  POSTGRES_PASSWORD PG_REPL_PASSWORD PG_EXPORTER_PASSWORD PG_APP_PASSWORD
  MONGO_ADMIN_PASSWORD MONGO_EXPORTER_PASSWORD MONGO_APP_PASSWORD
  MYSQL_FAILOVER_PASSWORD PG_FAILOVER_PASSWORD
)

# 32 caracteres hex. Se reintenta y se valida: en Git Bash, openssl a veces devuelve vacío la primera vez.
gen() {
  local v="" i
  for i in 1 2 3 4 5; do
    v="$(openssl rand -hex 16 2>/dev/null | tr -d '\r\n')" || v=""
    [[ ${#v} -eq 32 ]] && { printf '%s' "$v"; return 0; }
  done
  falla "openssl no generó una contraseña válida"
}

valor_de() { tr -d '\r' < "$SECRETOS_ENV" | awk -F= -v k="$1" '$1 == k { print substr($0, length(k) + 2); exit }'; }

if [[ "${1:-}" == "--forzar" ]]; then
  aviso "Regenerando TODOS los secretos: habrá que reinicializar los 3 motores y reiniciar Mongo."
  rm -f "$SECRETOS_ENV" "$SECRETOS_KEYFILE"
fi

if [[ ! -f "$SECRETOS_ENV" ]]; then
  printf '# Generado por scripts/generar-secretos.sh el %s.\n# NO subir al repo. NO copiar a la bóveda de Obsidian.\n' "$(date +%F)" > "$SECRETOS_ENV"
  info "Creando secretos/ingdatos.env"
fi

# Completa solo las claves que falten o estén vacías; las demás no se tocan.
for k in "${CLAVES[@]}"; do
  actual="$(valor_de "$k")"
  if [[ -z "$actual" ]]; then
    nuevo="$(gen)"
    if grep -q "^$k=" "$SECRETOS_ENV"; then
      sed -i "s/^$k=.*/$k=$nuevo/" "$SECRETOS_ENV"
    else
      printf '%s=%s\n' "$k" "$nuevo" >> "$SECRETOS_ENV"
    fi
    ok "Generada $k"
  fi
done

# keyFile: autenticación interna entre miembros de Mongo (debe ser idéntico en todos)
if [[ ! -s "$SECRETOS_KEYFILE" ]]; then
  openssl rand -base64 756 | tr -d '\r' > "$SECRETOS_KEYFILE"
  ok "Generado mongo-keyfile"
fi

# Validación final: ninguna clave puede quedar vacía.
for k in "${CLAVES[@]}"; do
  v="$(valor_de "$k")"
  [[ ${#v} -ge 16 ]] || falla "La clave $k quedó vacía o corta en secretos/ingdatos.env"
done
[[ $(wc -c < "$SECRETOS_KEYFILE") -ge 100 ]] || falla "mongo-keyfile quedó vacío"
ok "Secretos completos y válidos (no se muestran)."

for rol in db1 db2 db3 app; do
  cp "$SECRETOS_ENV" "$RAIZ/roles/$rol/.env"
done
ok "Copiado el .env a roles/db1, db2, db3 y app."
