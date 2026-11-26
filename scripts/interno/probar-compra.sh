#!/usr/bin/env bash
# Prueba de punta a punta de POST /compras (hito de la S3: una compra recorre los 3 motores).
# Se corre en cualquier máquina de la LAN con curl. Usa los datos de los seeds.
#   bash scripts/interno/probar-compra.sh            → contra http://app:8080
#   API=http://192.168.1.101:8080 bash scripts/interno/probar-compra.sh
set -uo pipefail
source "$(dirname "$0")/lib.sh"
API="${API:-http://app:8080}"
CLAVE="prueba-$(date +%s)"

pedir() {  # pedir MÉTODO RUTA [JSON] [encabezado]
  local args=(-s -w '\n← HTTP %{http_code} en %{time_total}s\n' -X "$1" "$API$2" -H 'Content-Type: application/json')
  [[ -n "${3:-}" ]] && args+=(-d "$3")
  [[ -n "${4:-}" ]] && args+=(-H "$4")
  curl "${args[@]}"
}
pedido_de() { sed -n 's/.*"pedido_id":\([0-9]*\).*/\1/p' <<<"$1" | head -1; }

titulo "1. Salud de los 3 motores"
pedir GET /salud

titulo "2. Compra con items (cliente 1, sucursal 1)"
r=$(pedir POST /compras '{"cliente_id":1,"sucursal_id":1,"items":[{"producto_id":1,"cantidad":2},{"producto_id":8,"cantidad":1}],"resena":{"calificacion":5,"comentario":"Prueba de la etapa 3"}}' "Idempotency-Key: $CLAVE")
echo "$r"
id=$(pedido_de "$r")

titulo "3. La misma compra otra vez (misma Idempotency-Key): debe decir repetida y el mismo pedido"
pedir POST /compras '{"cliente_id":1,"sucursal_id":1,"items":[{"producto_id":1,"cantidad":2},{"producto_id":8,"cantidad":1}]}' "Idempotency-Key: $CLAVE"

titulo "4. Llenar el carrito del cliente 1 y comprar desde él (Mongo), sin items"
pedir PUT /carritos/1 '{"sucursal_id":5,"items":[{"producto_id":211,"cantidad":1},{"producto_id":674,"cantidad":1}]}'
pedir POST /compras '{"cliente_id":1,"sucursal_id":5}'

titulo "5. Stock insuficiente → la Saga compensa y el pedido queda CANCELADO"
r5=$(pedir POST /compras '{"cliente_id":2,"sucursal_id":2,"items":[{"producto_id":3,"cantidad":1},{"producto_id":4,"cantidad":1000}]}')
echo "$r5"

if [[ -n "$id" ]]; then
  titulo "6. Pedido $id reconstruido desde los 3 motores"
  pedir GET "/pedidos/$id"
fi
id5=$(pedido_de "$r5")
if [[ -n "$id5" ]]; then
  titulo "7. Pedido cancelado $id5: sin reservas activas y con eventos de compensación"
  pedir GET "/pedidos/$id5"
fi

titulo "8. Inventario de la sucursal 1 (solo su fragmento)"
pedir GET "/inventario/1?producto_id=1,8"

titulo "9. Métricas de la API"
curl -s "$API/metrics" | grep -E '^(compras_total|compensaciones_total|saga_fallas_total)'
echo
