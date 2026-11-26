#!/usr/bin/env bash
# Últimos pedidos y su recorrido por los 3 motores (Saga), leídos a través de la API.
# Sirve para la demo: después del simulador muestra que cada compra quedó en MySQL, PostgreSQL y Mongo.
#   bash scripts/interno/ultimos.sh              → los últimos 5 pedidos
#   bash scripts/interno/ultimos.sh 10           → los últimos 10 (máximo 50)
#   bash scripts/interno/ultimos.sh --pedido 123 → solo el pedido 123
# Corre en cualquier máquina que alcance a app:8080. Necesita curl y jq (sudo apt install jq; sin internet, antes).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

API="${API:-http://app:8080}"
VIGILANTE="${VIGILANTE:-http://app:8090}"
export TZ="${TZ:-America/Mexico_City}"   # horas como en Grafana y en el reporte del simulador
command -v jq >/dev/null || falla "Falta jq: sudo apt install jq"

case "${1:-}" in
  --pedido) [[ "${2:-}" =~ ^[0-9]+$ ]] || falla "Uso: bash scripts/interno/ultimos.sh --pedido <id>"; IDS="$2" ;;
  "")       IDS=$(curl -fsS -m 10 "$API/pedidos?ultimos=5" | jq -r '.ids[]') ;;
  *)        [[ "$1" =~ ^[0-9]+$ ]] || falla "Uso: bash scripts/interno/ultimos.sh [N] | --pedido <id>"
            IDS=$(curl -fsS -m 10 "$API/pedidos?ultimos=$1" | jq -r '.ids[]') ;;
esac
[[ -n "$IDS" ]] || falla "La API no devolvió pedidos ($API)"

primarios=$(curl -fsS -m 5 "$VIGILANTE/estado" 2>/dev/null \
  | jq -r '"MySQL \(.mysql.primario // "?") · PostgreSQL \(.postgres.primario // "?")"' 2>/dev/null || echo "vigilante sin respuesta")
titulo "Últimos pedidos — primarios ahora: $primarios"

for id in $IDS; do
  curl -fsS -m 10 "$API/pedidos/$id" | jq -r '
    # MySQL guarda la fecha en UTC sin zona; Mongo y PostgreSQL en ISO con milisegundos.
    def hora: if . == null then "—" else
      (tostring | sub(" "; "T") | sub("\\.[0-9]+"; "") | sub("Z?$"; "Z") | fromdateiso8601 | strflocaltime("%H:%M:%S")) end;
    .mysql as $m |
    "\nPedido \($m.id) · \($m.fecha | hora) · cliente \($m.cliente_id) · sucursal \($m.sucursal_id) · $\($m.total) · \($m.estado)",
    "  MySQL       pedidos ⋈ pedido_cliente: \($m.destinatario), \($m.ciudad) · \($m.detalle | length) producto(s): "
      + ([$m.detalle[] | "\(.producto_id)×\(.cantidad)"] | join(", ")),
    "  PostgreSQL  reservas: " + (if (.postgres.reservas | type) == "array"
      then (if (.postgres.reservas | length) == 0 then "ninguna"
            else ([.postgres.reservas[] | "\(.producto_id)×\(.cantidad) en sucursal \(.sucursal_id) (\(.estado))"] | join(", ")) end)
      else "sin respuesta: \(.postgres.reservas.error)" end),
    "  Mongo       eventos de la Saga:" + (if (.mongo.eventos | type) == "array"
      then ([.mongo.eventos[] | "\n                paso \(.paso // "-") \(.tipo) (\(.motor // "-")) \(.fecha | hora)"] | join(""))
      else " sin respuesta: \(.mongo.eventos.error)" end)'
done
echo
