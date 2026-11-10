#!/usr/bin/env bash
# Instala en /etc/hosts los nombres de rol (db1, db2, db3, app, mon) del entorno elegido.
# Uso:  bash scripts/aplicar-hosts.sh casa      (o: uni)
# Es idempotente: reemplaza el bloque anterior entre las marcas, no duplica líneas.
set -euo pipefail

ENTORNO="${1:-}"
if [[ "$ENTORNO" != "casa" && "$ENTORNO" != "uni" ]]; then
  echo "Uso: bash $0 casa|uni" >&2
  exit 1
fi

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ORIGEN="$RAIZ/hosts/hosts.$ENTORNO"
[[ -f "$ORIGEN" ]] || { echo "No existe $ORIGEN" >&2; exit 1; }

INICIO="# >>> ingdatos"
FIN="# <<< ingdatos"
ROLES="db1 db2 db3 app mon"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# 1. Copia de /etc/hosts sin el bloque anterior del proyecto.
awk -v ini="$INICIO" -v fin="$FIN" '
  index($0, ini) == 1 { dentro = 1; next }
  index($0, fin) == 1 { dentro = 0; next }
  !dentro { print }
' /etc/hosts > "$TMP"

# 2. Bloque nuevo (sin comentarios, sin líneas vacías, sin \r de Windows).
{
  echo "$INICIO ($ENTORNO) — generado por scripts/aplicar-hosts.sh"
  tr -d '\r' < "$ORIGEN" | grep -vE '^[[:space:]]*(#|$)'
  echo "$FIN"
} >> "$TMP"

# 3. Respaldo e instalación.
sudo cp /etc/hosts /etc/hosts.bak-ingdatos
sudo cp "$TMP" /etc/hosts
sudo chmod 644 /etc/hosts
echo "OK: /etc/hosts actualizado para '$ENTORNO' (respaldo en /etc/hosts.bak-ingdatos)."

# 4. Aviso: un rol no debe apuntar a 127.x (rompería la replicación).
for rol in $ROLES; do
  if grep -E '^127\.' /etc/hosts | grep -qwE "$rol"; then
    echo "AVISO: '$rol' aparece en una línea 127.x de /etc/hosts. Quítalo de esa línea." >&2
  fi
done

# 5. Comprobación: cómo resuelve cada rol y si responde.
echo
printf '%-5s %-16s %s\n' "ROL" "IP" "PING"
for rol in $ROLES; do
  ip="$(getent hosts "$rol" | awk '{print $1; exit}')"
  if ping -c1 -W1 "$rol" >/dev/null 2>&1; then estado="responde"; else estado="sin respuesta"; fi
  printf '%-5s %-16s %s\n' "$rol" "${ip:-(no resuelve)}" "$estado"
done
