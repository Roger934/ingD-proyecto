// Métricas para Prometheus (GET /metrics). Las usa el dashboard "Plataforma" (F5).
'use strict';
const client = require('prom-client');

const registro = new client.Registry();
client.collectDefaultMetrics({ register: registro, prefix: 'api_' });

const compras = new client.Counter({
  name: 'compras_total', help: 'Compras procesadas por resultado',
  labelNames: ['resultado'], // confirmada | cancelada | rechazada | error | repetida
  registers: [registro],
});
const duracion = new client.Histogram({
  name: 'compra_duracion_segundos', help: 'Duración de POST /compras',
  labelNames: ['resultado'], buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registro],
});
const compensaciones = new client.Counter({
  name: 'compensaciones_total', help: 'Compensaciones de la Saga ejecutadas',
  labelNames: ['tipo', 'resultado'], // tipo: cancelar_pedido | liberar_reserva ; resultado: ok | fallida
  registers: [registro],
});
const fallasPaso = new client.Counter({
  name: 'saga_fallas_total', help: 'Fallas por paso y motor de la Saga',
  labelNames: ['paso', 'motor'],
  registers: [registro],
});

module.exports = { registro, compras, duracion, compensaciones, fallasPaso };
