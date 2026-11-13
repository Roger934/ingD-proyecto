#!/usr/bin/env node
// Simulador de transacciones (D26). Compra por HTTP a la API, sin intervención manual, y al final da un reporte.
// Sin dependencias: solo Node ≥ 22 (fetch incluido).
//
// Dos modos:
//   N transacciones (lazo cerrado):   node simulador.js --n 1000 [--concurrencia 10]
//   X por segundo durante T (abierto): node simulador.js --tps 20 --minutos 5
//
// Cada transacción es una compra completa (la Saga de 6 pasos de la API):
//   - cliente, sucursal y 1 a 3 productos al azar (los IDs del catálogo maestro: seed/generar.js);
//   - una parte compra desde el carrito (PUT /carritos/:cliente y luego POST /compras sin items);
//   - una parte deja reseña;
//   - una parte pide 1000 piezas de un producto (el inventario máximo es 600): la Saga compensa
//     y el pedido queda CANCELADO. Así el reporte y Grafana muestran compensaciones reales.
//
// Tolerancia a fallas: si la API responde 5xx o no responde, la MISMA compra se reintenta con la
// MISMA Idempotency-Key (backoff hasta --reintentar-hasta segundos). La API garantiza que no se
// duplica: si la compra sí se había hecho, responde "repetida" con el pedido original.
// Los huecos en que ninguna petición tuvo respuesta útil se reportan como "sin servicio".
'use strict';

const AYUDA = `
Simulador de compras — Proyecto Ing. de Datos

Uso:
  node simulador.js --n 1000                  1000 compras con 10 en paralelo
  node simulador.js --tps 20 --minutos 5      20 compras por segundo durante 5 minutos

Opciones:
  --n N                  número de compras (modo lazo cerrado)
  --concurrencia C       compras en paralelo en el modo --n (10)
  --tps X                compras por segundo (modo lazo abierto)
  --minutos T            duración del modo --tps (también --segundos)
  --api URL              API (http://app:8080, o la variable API)
  --vigilante URL        estado del vigilante (http://app:8090, o la variable VIGILANTE); "no" para omitir
  --pct-carrito P        % de compras desde el carrito (30)
  --pct-resena P         % de compras con reseña (10)
  --pct-sin-stock P      % de compras que piden más de lo que hay y se compensan (5)
  --reintentar-hasta S   segundos máximos reintentando una compra sin respuesta (60)
  --max-en-vuelo M       tope de compras simultáneas en el modo --tps (200)
  --verificar K          pedidos que se revisan al final en los 3 motores (20; 0 = no)
  --json                 imprime el reporte en JSON (el progreso va a stderr)
  --silencioso           sin línea de progreso
  -h, --ayuda            esta ayuda

Ctrl+C detiene el envío, espera las compras en curso e imprime el reporte (un segundo Ctrl+C sale ya).
`;

// ---------- Opciones ----------
function leerOpciones(argv) {
  const o = {
    n: null, concurrencia: 10, tps: null, segundos: null,
    api: process.env.API || 'http://app:8080', vigilante: process.env.VIGILANTE || 'http://app:8090',
    pctCarrito: 30, pctResena: 10, pctSinStock: 5, reintentarHasta: 60, maxEnVuelo: 200, verificar: 20,
    json: false, silencioso: false,
  };
  const num = (k, v, min, max) => {
    const x = Number(v);
    if (v === undefined || !Number.isFinite(x) || x < min || x > max) salirConError(`${k} debe ser un número entre ${min} y ${max}`);
    return x;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    const tomar = () => { i++; return v; };
    switch (k) {
      case '-h': case '--ayuda': case '--help': process.stdout.write(AYUDA); process.exit(0); break;
      case '--n': o.n = Math.floor(num(k, tomar(), 1, 1e7)); break;
      case '--concurrencia': o.concurrencia = Math.floor(num(k, tomar(), 1, 1000)); break;
      case '--tps': o.tps = num(k, tomar(), 0.1, 5000); break;
      case '--minutos': o.segundos = num(k, tomar(), 0.05, 24 * 60) * 60; break;
      case '--segundos': o.segundos = num(k, tomar(), 1, 24 * 3600); break;
      case '--api': o.api = tomar(); break;
      case '--vigilante': o.vigilante = tomar(); break;
      case '--pct-carrito': o.pctCarrito = num(k, tomar(), 0, 100); break;
      case '--pct-resena': o.pctResena = num(k, tomar(), 0, 100); break;
      case '--pct-sin-stock': o.pctSinStock = num(k, tomar(), 0, 100); break;
      case '--reintentar-hasta': o.reintentarHasta = num(k, tomar(), 0, 3600); break;
      case '--max-en-vuelo': o.maxEnVuelo = Math.floor(num(k, tomar(), 1, 10000)); break;
      case '--verificar': o.verificar = Math.floor(num(k, tomar(), 0, 1000)); break;
      case '--json': o.json = true; break;
      case '--silencioso': o.silencioso = true; break;
      default: salirConError(`Opción desconocida: ${k}  (usa --ayuda)`);
    }
  }
  if ((o.n === null) === (o.tps === null)) salirConError('Elige un modo: --n N  o  --tps X --minutos T');
  if (o.tps !== null && o.segundos === null) salirConError('El modo --tps necesita --minutos T (o --segundos S)');
  if (o.n !== null && o.segundos !== null) salirConError('--minutos/--segundos solo aplican al modo --tps');
  o.api = o.api.replace(/\/+$/, '');
  o.vigilante = o.vigilante === 'no' ? null : o.vigilante.replace(/\/+$/, '');
  return o;
}

function salirConError(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(2);
}

// ---------- Datos de las compras (rangos del catálogo maestro, seed/generar.js) ----------
const RANGO = { clientes: 10000, productos: 4000, sucursales: 5 };
const ent = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const probabilidad = (pct) => Math.random() * 100 < pct;

const clientesEnUso = new Set(); // dos compras simultáneas no comparten cliente (ni carrito)
function tomarCliente() {
  for (;;) {
    const c = ent(1, RANGO.clientes);
    if (!clientesEnUso.has(c)) { clientesEnUso.add(c); return c; }
  }
}

function armarCompra(o, numero, corrida) {
  const cliente_id = tomarCliente();
  const sucursal_id = ent(1, RANGO.sucursales);
  const productos = new Set();
  const lineas = ent(1, 3);
  while (productos.size < lineas) productos.add(ent(1, RANGO.productos));
  const items = [...productos].map((producto_id) => ({ producto_id, cantidad: ent(1, 3) }));
  const sinStock = probabilidad(o.pctSinStock);
  if (sinStock) items[items.length - 1].cantidad = 1000; // el inventario máximo es 600
  const tipo = sinStock ? 'sin_stock' : probabilidad(o.pctCarrito) ? 'carrito' : 'directa';
  const cuerpo = { cliente_id, sucursal_id };
  if (tipo !== 'carrito') cuerpo.items = items;
  if (probabilidad(o.pctResena)) cuerpo.resena = { calificacion: ent(3, 5), comentario: 'Reseña generada por el simulador' };
  return { numero, tipo, cliente_id, sucursal_id, items, cuerpo, clave: `sim-${corrida}-${numero}` };
}

// ---------- Estadísticas ----------
const est = {
  enviadas: 0, terminadas: 0, enVuelo: 0, omitidas: 0,
  resultado: { confirmada: 0, compensada: 0, rechazada: 0, error: 0, interrumpida: 0 },
  porTipo: { directa: 0, carrito: 0, sin_stock: 0 },
  trasReintento: 0, recuperadasIdempotencia: 0, reintentos: 0,
  latPeticion: [], latCompra: [],
  intentos: [],            // { ini, fin, util } de cada POST, para calcular los huecos sin servicio
  motivos: new Map(),      // motivo de cada respuesta no útil o rechazo → cuántas
  pedidos: { confirmada: [], compensada: [] },
};
const contar = (motivo) => est.motivos.set(motivo, (est.motivos.get(motivo) || 0) + 1);

function percentil(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// Huecos sin servicio. Un segundo está "caído" si la mayoría de las peticiones que empezaron en él fallaron
// (durante una caída algunas repeticiones idempotentes sí responden; por eso no basta con una sola respuesta).
// Los segundos caídos seguidos forman una ventana: de la primera falla a la última.
function ventanasSinServicio() {
  const porSegundo = new Map();
  for (const x of est.intentos) {
    const s = Math.floor(x.ini / 1000);
    const b = porSegundo.get(s) || { fallas: 0, utiles: 0, desde: Infinity, hasta: 0 };
    if (x.util) b.utiles++;
    else { b.fallas++; b.desde = Math.min(b.desde, x.ini); b.hasta = Math.max(b.hasta, x.fin); }
    porSegundo.set(s, b);
  }
  const ultimoUtil = est.intentos.reduce((t, x) => (x.util ? Math.max(t, x.fin) : t), 0);
  const ventanas = [];
  let actual = null, previo = null;
  for (const s of [...porSegundo.keys()].sort((a, b) => a - b)) {
    const b = porSegundo.get(s);
    if (b.fallas > b.utiles) {
      if (actual && previo === s - 1) actual.hasta = Math.max(actual.hasta, b.hasta);
      else { actual = { desde: b.desde, hasta: b.hasta }; ventanas.push(actual); }
      previo = s;
    }
  }
  for (const v of ventanas) if (ultimoUtil < v.hasta) v.abierta = true; // nunca volvió a responder
  return ventanas;
}

// ---------- HTTP ----------
const TIMEOUT_MS = 15000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(o, metodo, ruta, cuerpo, encabezados = {}) {
  const ini = Date.now();
  try {
    const r = await fetch(o.api + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...encabezados },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json = null;
    try { json = await r.json(); } catch { /* respuesta sin JSON */ }
    return { status: r.status, json, ini, fin: Date.now() };
  } catch (e) {
    const motivo = e.name === 'TimeoutError' ? 'sin respuesta en 15 s' : `red: ${(e.cause && e.cause.code) || e.message}`;
    return { status: 0, json: null, red: motivo, ini, fin: Date.now() };
  }
}

// ¿Se puede reintentar con la misma clave? (falla de la plataforma, no regla de negocio)
const reintentable = (r) => r.status === 0 || r.status >= 500 || (r.status === 409 && r.json && r.json.error === 'COMPRA_EN_CURSO');
const motivoDe = (r) => r.red || `${r.status} ${(r.json && r.json.error) || ''}${r.json && r.json.motor ? ` (${r.json.motor})` : ''}`.trim();

let detener = false;

// Repite una petición mientras la falla sea de la plataforma, hasta el límite de tiempo.
async function conReintentos(o, compra, fn) {
  const limite = Date.now() + o.reintentarHasta * 1000;
  let espera = 250, intento = 0;
  for (;;) {
    const r = await fn();
    if (!reintentable(r)) return { r, intento };
    contar(motivoDe(r));
    if (detener || Date.now() + espera > limite) return { r, intento, agotado: !detener, interrumpida: detener };
    intento++;
    est.reintentos++;
    await dormir(espera);
    espera = Math.min(espera * 2, 2000);
  }
}

// ---------- Una compra ----------
async function comprar(o, compra) {
  const ini = Date.now();
  est.enviadas++; est.enVuelo++; est.porTipo[compra.tipo]++;
  let resultado;
  try {
    if (compra.tipo === 'carrito') {
      const p = await conReintentos(o, compra, () => http(o, 'PUT', `/carritos/${compra.cliente_id}`,
        { sucursal_id: compra.sucursal_id, items: compra.items }));
      if (p.r.status !== 200) {
        resultado = p.interrumpida ? 'interrumpida' : p.agotado ? 'error' : 'rechazada';
        if (!p.agotado && !p.interrumpida) contar(`carrito: ${motivoDe(p.r)}`);
        return;
      }
    }
    const p = await conReintentos(o, compra, async () => {
      const r = await http(o, 'POST', '/compras', compra.cuerpo, { 'Idempotency-Key': compra.clave });
      est.latPeticion.push(r.fin - r.ini);
      est.intentos.push({ ini: r.ini, fin: r.fin, util: !reintentable(r) });
      return r;
    });
    const { r } = p;
    if (p.interrumpida) { resultado = 'interrumpida'; return; }
    if (p.agotado) { resultado = 'error'; return; }
    const j = r.json || {};
    if ((r.status === 201 || r.status === 200) && j.estado === 'CONFIRMADO') {
      resultado = 'confirmada';
      if (j.repetida) est.recuperadasIdempotencia++;
      est.pedidos.confirmada.push(j.pedido_id);
    } else if ((r.status === 200 && j.repetida && j.estado === 'CANCELADO') || (r.status === 409 && j.pedido_id && j.cancelado)) {
      resultado = 'compensada';
      if (j.repetida) est.recuperadasIdempotencia++;
      est.pedidos.compensada.push(j.pedido_id);
      if (!j.repetida) contar(`compensada: ${j.error}`);
    } else {
      resultado = 'rechazada';
      contar(`rechazada: ${motivoDe(r)}`);
    }
    if (p.intento > 0) est.trasReintento++;
  } finally {
    est.resultado[resultado]++;
    if (resultado === 'confirmada' || resultado === 'compensada') est.latCompra.push(Date.now() - ini);
    est.terminadas++; est.enVuelo--;
    clientesEnUso.delete(compra.cliente_id);
  }
}

// ---------- Modos ----------
async function modoN(o, corrida) {
  let siguiente = 0;
  const trabajador = async () => {
    while (!detener && siguiente < o.n) {
      const numero = ++siguiente;
      await comprar(o, armarCompra(o, numero, corrida));
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrencia, o.n) }, trabajador));
}

async function modoTps(o, corrida) {
  const intervalo = 1000 / o.tps;
  const inicio = Date.now(), fin = inicio + o.segundos * 1000;
  const enCurso = new Set();
  let numero = 0, proxima = inicio;
  while (!detener && proxima < fin) {
    const espera = proxima - Date.now();
    if (espera > 0) await dormir(espera);
    if (detener) break;
    proxima += intervalo;
    numero++;
    if (est.enVuelo >= o.maxEnVuelo) { est.omitidas++; continue; } // la plataforma no da abasto: no se acumulan sin fin
    const p = comprar(o, armarCompra(o, numero, corrida)).finally(() => enCurso.delete(p));
    enCurso.add(p);
  }
  await Promise.all(enCurso);
}

// ---------- Progreso ----------
const hora = (t) => new Date(t).toTimeString().slice(0, 8);
const horaMs = (t) => { const d = new Date(t); return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
const seg = (ms) => (ms / 1000).toFixed(1);

function iniciarProgreso(o, t0) {
  if (o.silencioso) return () => {};
  const tty = process.stderr.isTTY;
  let previas = 0, tPrevio = t0;
  const pintar = (final) => {
    const ahora = Date.now();
    const tps = ((est.terminadas - previas) * 1000) / Math.max(1, ahora - tPrevio);
    previas = est.terminadas; tPrevio = ahora;
    const total = o.n ? `/${o.n}` : '';
    const r = est.resultado;
    let linea = `[${seg(ahora - t0).padStart(6)} s] ${est.terminadas}${total} · ${tps.toFixed(1)}/s · en curso ${est.enVuelo}`
      + ` · ✔ ${r.confirmada} · ↺ ${r.compensada} · ✖ ${r.rechazada + r.error} · reintentos ${est.reintentos}`;
    // Si la línea es más ancha que la terminal, se parte y el \r ya no la borra: se recorta al ancho.
    const ancho = (process.stderr.columns || 80) - 1;
    if (tty && linea.length > ancho) linea = linea.slice(0, ancho);
    process.stderr.write(tty ? `\r\x1b[K${linea}${final ? '\n' : ''}` : `${linea}\n`);
  };
  const id = setInterval(pintar, tty ? 1000 : 5000);
  return () => { clearInterval(id); pintar(true); };
}

// ---------- Vigilante y verificación ----------
async function primarios(o) {
  if (!o.vigilante) return null;
  try {
    const r = await fetch(`${o.vigilante}/estado`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return { mysql: j.mysql ? j.mysql.primario : null, postgres: j.postgres ? j.postgres.primario : null };
  } catch { return null; }
}

function muestra(arr, k) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

// Revisa en los 3 motores (GET /pedidos/:id) que cada pedido quedó coherente con su resultado.
async function verificar(o) {
  if (!o.verificar) return null;
  const kComp = Math.min(est.pedidos.compensada.length, Math.ceil(o.verificar / 4));
  const lista = [
    ...muestra(est.pedidos.compensada, kComp).map((id) => ({ id, esperado: 'CANCELADO' })),
    ...muestra(est.pedidos.confirmada, o.verificar - kComp).map((id) => ({ id, esperado: 'CONFIRMADO' })),
  ];
  const problemas = [];
  let ok = 0;
  for (const { id, esperado } of lista) {
    const r = await http(o, 'GET', `/pedidos/${id}`);
    const j = r.json || {};
    const fallas = [];
    if (r.status !== 200) fallas.push(`HTTP ${r.status || r.red}`);
    else {
      const estado = j.mysql && j.mysql.estado;
      const reservas = j.postgres && Array.isArray(j.postgres.reservas) ? j.postgres.reservas : null;
      const eventos = j.mongo && Array.isArray(j.mongo.eventos) ? j.mongo.eventos.map((e) => e.tipo) : null;
      if (estado !== esperado) fallas.push(`MySQL dice ${estado}`);
      if (!reservas) fallas.push('PostgreSQL no respondió');
      else if (esperado === 'CONFIRMADO') {
        const lineas = (j.mysql.detalle || []).length;
        const activas = reservas.filter((x) => x.estado === 'ACTIVA').length;
        if (activas !== lineas) fallas.push(`PostgreSQL: ${activas} reservas activas para ${lineas} líneas`);
      } else if (reservas.some((x) => x.estado === 'ACTIVA')) fallas.push('PostgreSQL: quedó una reserva ACTIVA');
      const evEsperado = esperado === 'CONFIRMADO' ? 'PEDIDO_CONFIRMADO' : 'PEDIDO_CANCELADO';
      if (!eventos) fallas.push('Mongo no respondió');
      else if (!eventos.includes(evEsperado)) fallas.push(`Mongo: falta el evento ${evEsperado}`);
    }
    if (fallas.length) problemas.push({ pedido_id: id, esperado, fallas });
    else ok++;
  }
  return { revisados: lista.length, ok, problemas };
}

// ---------- Reporte ----------
function armarReporte(o, t0, t1, antes, despues, consistencia) {
  const r = est.resultado;
  const ventanas = ventanasSinServicio();
  const sinServicioMs = ventanas.reduce((s, v) => s + (v.hasta - v.desde), 0);
  const ms = (x) => (x === null ? null : Math.round(x));
  return {
    modo: o.n ? { tipo: 'n', transacciones: o.n, concurrencia: o.concurrencia } : { tipo: 'tps', tps: o.tps, segundos: o.segundos },
    api: o.api,
    inicio: new Date(t0).toISOString(), fin: new Date(t1).toISOString(), duracion_s: Number(seg(t1 - t0)),
    compras: {
      enviadas: est.enviadas, ...r, omitidas_por_saturacion: est.omitidas,
      por_tipo: est.porTipo,
      tras_reintento: est.trasReintento, recuperadas_por_idempotencia: est.recuperadasIdempotencia, reintentos: est.reintentos,
    },
    rendimiento: {
      confirmadas_por_s: Number((r.confirmada / Math.max(0.001, (t1 - t0) / 1000)).toFixed(1)),
      latencia_peticion_ms: { p50: ms(percentil(est.latPeticion, 50)), p95: ms(percentil(est.latPeticion, 95)),
        p99: ms(percentil(est.latPeticion, 99)), max: ms(percentil(est.latPeticion, 100)) },
      latencia_compra_ms: { p50: ms(percentil(est.latCompra, 50)), p95: ms(percentil(est.latCompra, 95)), max: ms(percentil(est.latCompra, 100)) },
    },
    disponibilidad: {
      segundos_sin_servicio: Number(seg(sinServicioMs)),
      ventanas: ventanas.map((v) => ({ desde: new Date(v.desde).toISOString(), hasta: new Date(v.hasta).toISOString(),
        segundos: Number(seg(v.hasta - v.desde)), ...(v.abierta ? { sin_recuperar: true } : {}) })),
      primarios_antes: antes, primarios_despues: despues,
    },
    motivos: Object.fromEntries([...est.motivos].sort((a, b) => b[1] - a[1])),
    consistencia,
  };
}

function imprimirReporte(rep, o, t0, t1) {
  const c = rep.compras, rd = rep.rendimiento, d = rep.disponibilidad;
  const L = [];
  const fila = (k, v, nota = '') => L.push(`  ${k.padEnd(22)}${String(v).padStart(8)}${nota ? `   ${nota}` : ''}`);
  const lat = (x) => (x === null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x} ms`);
  L.push('', '══════════════ Reporte del simulador ══════════════');
  L.push(o.n ? `Modo: ${o.n} compras, ${o.concurrencia} en paralelo` : `Modo: ${o.tps} compras/s durante ${seg(o.segundos * 1000)} s`);
  L.push(`API: ${o.api}`);
  L.push(`Inicio ${hora(t0)} · Fin ${hora(t1)} · Duración ${seg(t1 - t0)} s`, '');
  L.push('Compras');
  fila('confirmadas', c.confirmada, c.tras_reintento ? `(${c.tras_reintento} terminaron tras reintentar)` : '');
  fila('compensadas', c.compensada, 'pedido CANCELADO y reserva liberada por la Saga');
  fila('rechazadas', c.rechazada, c.rechazada ? 'regla de negocio (ver motivos)' : '');
  fila('errores', c.error, c.error ? `sin respuesta tras ${o.reintentarHasta} s de reintentos` : '');
  if (c.interrumpida) fila('interrumpidas', c.interrumpida, 'por Ctrl+C');
  L.push(`  ${'─'.repeat(30)}`);
  fila('total', c.enviadas, `directas ${c.por_tipo.directa} · desde carrito ${c.por_tipo.carrito} · sin stock ${c.por_tipo.sin_stock}`);
  if (c.omitidas_por_saturacion) fila('no enviadas', c.omitidas_por_saturacion, `ya había ${o.maxEnVuelo} en curso`);
  if (c.reintentos) L.push(`  Reintentos: ${c.reintentos} · recuperadas por idempotencia (la compra ya se había hecho): ${c.recuperadas_por_idempotencia}`);
  L.push('', 'Rendimiento');
  L.push(`  ${rd.confirmadas_por_s} compras confirmadas por segundo`);
  const lp = rd.latencia_peticion_ms, lc = rd.latencia_compra_ms;
  L.push(`  Latencia por petición:        p50 ${lat(lp.p50)} · p95 ${lat(lp.p95)} · p99 ${lat(lp.p99)} · máx ${lat(lp.max)}`);
  L.push(`  Latencia por compra (con reintentos): p50 ${lat(lc.p50)} · p95 ${lat(lc.p95)} · máx ${lat(lc.max)}`);
  L.push('', 'Disponibilidad');
  if (!d.ventanas.length) L.push('  Sin interrupciones: todas las peticiones tuvieron respuesta.');
  else {
    L.push(`  ${d.segundos_sin_servicio} s sin servicio en ${d.ventanas.length} ventana(s):`);
    for (const v of d.ventanas) L.push(`    ${horaMs(Date.parse(v.desde))} → ${horaMs(Date.parse(v.hasta))}   ${v.segundos} s${v.sin_recuperar ? '   (no se recuperó antes de terminar)' : ''}`);
  }
  const prim = (p) => (p ? `MySQL ${p.mysql || '—'} · PostgreSQL ${p.postgres || '—'}` : 'vigilante no disponible');
  if (o.vigilante) {
    L.push(`  Primarios al inicio:  ${prim(d.primarios_antes)}`);
    L.push(`  Primarios al final:   ${prim(d.primarios_despues)}`);
    const a = d.primarios_antes, b = d.primarios_despues;
    if (a && b && (a.mysql !== b.mysql || a.postgres !== b.postgres)) L.push('  → Hubo failover durante la corrida.');
  }
  const mot = Object.entries(rep.motivos);
  if (mot.length) {
    L.push('', 'Motivos (respuestas sin éxito, incluye los reintentos)');
    for (const [k, v] of mot.slice(0, 12)) L.push(`  ${String(v).padStart(6)}  ${k}`);
  }
  if (rep.consistencia) {
    const k = rep.consistencia;
    L.push('', `Consistencia entre los 3 motores (muestra de ${k.revisados} pedidos): ${k.ok}/${k.revisados} correctos`);
    for (const p of k.problemas.slice(0, 10)) L.push(`  ✖ pedido ${p.pedido_id} (${p.esperado}): ${p.fallas.join('; ')}`);
  }
  L.push('═══════════════════════════════════════════════════', '');
  process.stdout.write(L.join('\n') + '\n');
}

// ---------- Principal ----------
async function main() {
  const o = leerOpciones(process.argv.slice(2));
  const corrida = Date.now().toString(36); // clave: sim-<corrida>-<n>, ≤ 36 caracteres

  const salud = await http(o, 'GET', '/salud');
  if (salud.status === 0) salirConError(`la API no responde en ${o.api} (${salud.red}). ¿Está arriba? Usa --api URL.`);
  if (salud.status !== 200) process.stderr.write(`Aviso: /salud respondió ${salud.status}; se empieza de todos modos.\n`);

  let interrupciones = 0;
  process.on('SIGINT', () => {
    if (++interrupciones > 1) process.exit(130);
    detener = true;
    process.stderr.write('\nDeteniendo: se esperan las compras en curso (Ctrl+C otra vez para salir ya)…\n');
  });
  process.on('SIGTERM', () => { detener = true; });

  const antes = await primarios(o);
  const t0 = Date.now();
  process.stderr.write(`Simulador ${corrida}: ${o.n ? `${o.n} compras, ${o.concurrencia} en paralelo` : `${o.tps}/s durante ${seg(o.segundos * 1000)} s`} → ${o.api}\n`);
  const pararProgreso = iniciarProgreso(o, t0);
  if (o.n) await modoN(o, corrida); else await modoTps(o, corrida);
  const t1 = Date.now();
  pararProgreso();

  const despues = await primarios(o);
  if (o.verificar && !o.silencioso) process.stderr.write('Verificando una muestra de pedidos en los 3 motores…\n');
  const consistencia = await verificar(o);
  const rep = armarReporte(o, t0, t1, antes, despues, consistencia);
  if (o.json) process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  else imprimirReporte(rep, o, t0, t1);

  const sano = rep.compras.error === 0 && (!consistencia || consistencia.problemas.length === 0);
  process.exit(sano ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
