#!/usr/bin/env node
// Catálogo maestro + seeds de los 3 motores (D10). Sin dependencias: solo Node ≥ 18.
//
// Es DETERMINISTA (semilla fija): en cualquier máquina genera exactamente los mismos datos,
// así cada motor se puede cargar desde la máquina donde vive y los IDs coinciden:
//   producto_id 1..4000  → catalogo (Mongo), productos_sucursal/inventario (PostgreSQL), detalle_pedido (MySQL)
//   sucursal_id 1..5     → sucursales (PostgreSQL), pedidos (MySQL), carritos (Mongo)
//   cliente_id  1..10000 → clientes (MySQL), carritos/resenas/logs_busqueda (Mongo)
//   pedido_id   1..12000 → pedidos (MySQL), reservas/movimientos (PostgreSQL), eventos (Mongo)
//
// Salida en seed/datos/ (fuera de git):
//   mysql.sql     INSERT multi-fila por lotes de 1000
//   postgres.sql  COPY ... FROM stdin
//   <coleccion>.ndjson  un documento por línea (las fechas van en ISO y el cargador las convierte a Date)
//   resumen.json  conteos esperados por tabla y colección
'use strict';
const fs = require('fs');
const path = require('path');

const SALIDA = path.join(__dirname, 'datos');
const N = { productos: 4000, clientes: 10000, pedidos: 12000, resenas: 25000, carritos: 6000, busquedas: 15000 };
const LOTE = 1000;

// ---------- Aleatorio con semilla ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261110);
const ent = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const elegir = (arr) => arr[Math.floor(rnd() * arr.length)];
const dinero = (x) => Math.round(x * 100) / 100;
const digitos = (n) => Array.from({ length: n }, () => ent(0, 9)).join('');
const fechaEntre = (desde, hasta) => new Date(desde.getTime() + Math.floor(rnd() * (hasta - desde)));
const sinAcentos = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const mysqlFecha = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const segundos = (d, s) => new Date(d.getTime() + s * 1000);

// ---------- Listas ----------
const NOMBRES = ['José', 'María', 'Juan', 'Guadalupe', 'Luis', 'Ana', 'Carlos', 'Fernanda', 'Jorge', 'Sofía', 'Miguel', 'Valeria',
  'Alejandro', 'Daniela', 'Ricardo', 'Camila', 'Fernando', 'Ximena', 'Eduardo', 'Regina', 'Roberto', 'Andrea', 'Diego', 'Paola',
  'Vladimir', 'Mariana', 'Eduardo', 'Gabriela', 'Héctor', 'Lucía', 'Sergio', 'Renata', 'Raúl', 'Natalia', 'Arturo', 'Karla'];
const APELLIDOS = ['Hernández', 'García', 'Martínez', 'López', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Cruz',
  'Flores', 'Gómez', 'Morales', 'Vázquez', 'Reyes', 'Jiménez', 'Torres', 'Díaz', 'Gutiérrez', 'Ruiz', 'Mendoza', 'Aguilar',
  'Ortiz', 'Moreno', 'Castillo', 'Romero', 'Álvarez', 'Méndez', 'Chávez', 'Rivera', 'Juárez', 'Ramos', 'Domínguez', 'Herrera'];
const CIUDADES = [['Ciudad de México', 'CDMX'], ['Monterrey', 'Nuevo León'], ['Guadalajara', 'Jalisco'], ['León', 'Guanajuato'],
  ['Mérida', 'Yucatán'], ['Puebla', 'Puebla'], ['Querétaro', 'Querétaro'], ['Aguascalientes', 'Aguascalientes'],
  ['San Luis Potosí', 'San Luis Potosí'], ['Morelia', 'Michoacán'], ['Toluca', 'Estado de México'], ['Saltillo', 'Coahuila']];
const CALLES = ['Av. Juárez', 'Calle Hidalgo', 'Av. Reforma', 'Calle Morelos', 'Av. Insurgentes', 'Calle Allende', 'Blvd. López Mateos',
  'Calle Zaragoza', 'Av. Universidad', 'Calle 5 de Mayo', 'Av. Revolución', 'Calle Independencia', 'Calz. Independencia'];
const INSTRUCCIONES = ['Dejar con el portero', 'Tocar el timbre dos veces', 'Entregar después de las 6 pm', 'Llamar antes de llegar',
  'Casa con portón negro', 'Dejar en recepción'];
const SUCURSALES = [
  [1, 'Sucursal Centro', 'Ciudad de México', 'Centro'],
  [2, 'Sucursal Norte', 'Monterrey', 'Norte'],
  [3, 'Sucursal Occidente', 'Guadalajara', 'Occidente'],
  [4, 'Sucursal Bajío', 'León', 'Bajío'],
  [5, 'Sucursal Sureste', 'Mérida', 'Sureste'],
];
const COLORES = ['negro', 'blanco', 'gris', 'azul', 'rojo', 'verde', 'beige'];

// Cada categoría tiene sus propios atributos (por eso el catálogo vive en Mongo).
const CATEGORIAS = {
  electronica: { tipos: ['Audífonos', 'Bocina', 'Smartwatch', 'Tablet', 'Monitor', 'Teclado', 'Mouse'], marcas: ['Sonix', 'Voltra', 'Nexo', 'Kairo'],
    precio: [250, 15000], atributos: () => ({ garantia_meses: elegir([6, 12, 24]), color: elegir(COLORES), conectividad: elegir(['Bluetooth', 'USB-C', 'WiFi', 'Cable']) }) },
  ropa: { tipos: ['Playera', 'Sudadera', 'Pantalón', 'Chamarra', 'Vestido', 'Gorra'], marcas: ['Urbana', 'Norte', 'Maya', 'Tlali'],
    precio: [150, 2500], atributos: () => ({ talla: elegir(['CH', 'M', 'G', 'EG']), color: elegir(COLORES), material: elegir(['algodón', 'poliéster', 'mezclilla', 'lino']) }) },
  hogar: { tipos: ['Lámpara', 'Sartén', 'Juego de sábanas', 'Silla', 'Cafetera', 'Organizador'], marcas: ['Casa Viva', 'Hogarex', 'Raíz'],
    precio: [120, 6000], atributos: () => ({ material: elegir(['madera', 'acero', 'cerámica', 'plástico']), dimensiones_cm: { alto: ent(10, 120), ancho: ent(10, 80), fondo: ent(5, 60) } }) },
  deportes: { tipos: ['Balón', 'Mancuernas', 'Tapete de yoga', 'Raqueta', 'Bicicleta estática', 'Guantes'], marcas: ['Atlas', 'Fénix', 'Kin'],
    precio: [180, 9000], atributos: () => ({ deporte: elegir(['fútbol', 'gimnasio', 'yoga', 'tenis', 'box', 'ciclismo']), peso_kg: dinero(0.2 + rnd() * 20) }) },
  libros: { tipos: ['Novela', 'Manual', 'Ensayo', 'Cómic', 'Libro de cocina'], marcas: ['Editorial Alba', 'Ediciones Sol', 'Grupo Lector'],
    precio: [90, 900], atributos: () => ({ autor: `${elegir(NOMBRES)} ${elegir(APELLIDOS)}`, paginas: ent(80, 900), isbn: '978' + digitos(10), pasta: elegir(['blanda', 'dura']) }) },
  juguetes: { tipos: ['Rompecabezas', 'Bloques', 'Muñeca', 'Carro a control', 'Juego de mesa'], marcas: ['Juguetón', 'Kiddo', 'Trompo'],
    precio: [100, 3500], atributos: () => ({ edad_minima: elegir([3, 5, 8, 12]), piezas: ent(1, 1500), requiere_pilas: rnd() < 0.3 }) },
  alimentos: { tipos: ['Café molido', 'Chocolate', 'Miel', 'Salsa', 'Granola', 'Té'], marcas: ['Sabor de Aquí', 'Milpa', 'Cacao Real'],
    precio: [40, 600], atributos: () => ({ contenido_g: elegir([100, 250, 500, 1000]), caducidad_dias: ent(60, 720), organico: rnd() < 0.4 }) },
};
const NOMBRES_CAT = Object.keys(CATEGORIAS);
const COMENTARIOS = {
  1: ['Llegó dañado', 'No es lo que esperaba', 'Mala calidad'],
  2: ['Regular, esperaba más', 'Tardó mucho en llegar'],
  3: ['Cumple, sin más', 'Está bien por el precio'],
  4: ['Muy buen producto', 'Buena calidad, lo recomiendo', 'Llegó rápido'],
  5: ['Excelente, lo volvería a comprar', 'Superó mis expectativas', 'Justo lo que buscaba'],
};

// ---------- Escritura ----------
fs.mkdirSync(SALIDA, { recursive: true });
const resumen = { generado: new Date().toISOString(), semilla: 20261110, mysql: {}, postgres: {}, mongo: {} };

function sqlValor(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}
function mysqlInserts(out, tabla, columnas, filas) {
  out.push(`-- ${tabla}: ${filas.length} filas`);
  for (let i = 0; i < filas.length; i += LOTE) {
    const valores = filas.slice(i, i + LOTE).map((f) => '(' + f.map(sqlValor).join(',') + ')').join(',\n');
    out.push(`INSERT INTO ${tabla} (${columnas.join(',')}) VALUES\n${valores};`);
  }
  out.push('COMMIT;');
  resumen.mysql[tabla] = filas.length;
}
function pgTexto(v) {
  if (v === null || v === undefined) return '\\N';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}
function pgCopy(out, tabla, columnas, filas) {
  out.push(`COPY ${tabla} (${columnas.join(',')}) FROM stdin;`);
  for (const f of filas) out.push(f.map(pgTexto).join('\t'));
  out.push('\\.');
  resumen.postgres[tabla] = (resumen.postgres[tabla] || 0) + filas.length;
}
function ndjson(coleccion, docs) {
  fs.writeFileSync(path.join(SALIDA, coleccion + '.ndjson'), docs.map((d) => JSON.stringify(d)).join('\n') + '\n');
  resumen.mongo[coleccion] = docs.length;
}

// ---------- Catálogo maestro ----------
const productos = [];
for (let id = 1; id <= N.productos; id++) {
  const categoria = NOMBRES_CAT[(id - 1) % NOMBRES_CAT.length];
  const c = CATEGORIAS[categoria];
  const marca = elegir(c.marcas);
  const tipo = elegir(c.tipos);
  const precio_lista = dinero(c.precio[0] + rnd() ** 2 * (c.precio[1] - c.precio[0]));
  productos.push({
    producto_id: id,
    sku: `${categoria.slice(0, 3).toUpperCase()}-${String(id).padStart(5, '0')}`,
    nombre: `${tipo} ${marca} ${ent(100, 999)}`,
    tipo, categoria, marca, precio_lista,
    atributos: c.atributos(),
    imagenes: Array.from({ length: ent(1, 4) }, (_, i) => `https://img.ecommerce.local/${id}/${i + 1}.jpg`),
    etiquetas: [categoria, tipo.toLowerCase(), marca.toLowerCase()],
    activo: true,
    creado: fechaEntre(new Date('2025-01-01'), new Date('2025-12-01')).toISOString(),
  });
}
// precio_local[producto][sucursal] = precio de lista ± 8 %
const precioLocal = productos.map((p) => SUCURSALES.map(() => dinero(p.precio_lista * (0.92 + rnd() * 0.16))));
const precio = (producto_id, sucursal_id) => precioLocal[producto_id - 1][sucursal_id - 1];

// ---------- MySQL: clientes, direcciones, pedidos, pedido_cliente, detalle_pedido ----------
const clientes = [];
const direcciones = [];
const principal = []; // dirección principal por cliente
for (let id = 1; id <= N.clientes; id++) {
  const nombre = elegir(NOMBRES), ap1 = elegir(APELLIDOS), ap2 = elegir(APELLIDOS);
  const cli = {
    id, nombre: `${nombre} ${ap1} ${ap2}`,
    email: `${sinAcentos(nombre)}.${sinAcentos(ap1)}${id}@correo.mx`,
    telefono: elegir(['55', '81', '33', '477', '999']) + digitos(8).slice(0, 8),
    fecha_alta: fechaEntre(new Date('2024-01-01'), new Date('2025-12-31')),
  };
  cli.telefono = cli.telefono.slice(0, 10);
  clientes.push(cli);
  const cuantas = rnd() < 0.5 ? 2 : 1;
  for (let k = 0; k < cuantas; k++) {
    const [ciudad, estado] = elegir(CIUDADES);
    const d = { id: direcciones.length + 1, cliente_id: id, calle: `${elegir(CALLES)} ${ent(1, 999)}`, ciudad, estado, cp: String(ent(1000, 99999)).padStart(5, '0'), principal: k === 0 ? 1 : 0 };
    direcciones.push(d);
    if (k === 0) principal[id] = d;
  }
}

const pedidos = [], pedidoCliente = [], detalles = [];
const reservas = [], movSalidas = [];
const vendidos = new Map(); // "producto:sucursal" → unidades confirmadas
const eventos = [];
let detalleId = 0;
for (let id = 1; id <= N.pedidos; id++) {
  const cli = clientes[ent(1, N.clientes) - 1];
  const sucursal_id = ent(1, SUCURSALES.length);
  const fecha = fechaEntre(new Date('2026-01-01'), new Date('2026-11-01'));
  const estado = rnd() < 0.9 ? 'CONFIRMADO' : 'CANCELADO';
  const elegidos = new Set();
  const lineas = ent(1, 3);
  while (elegidos.size < lineas) elegidos.add(ent(1, N.productos));
  let total = 0;
  for (const producto_id of [...elegidos].sort((a, b) => a - b)) {
    const cantidad = ent(1, 3);
    const pu = precio(producto_id, sucursal_id);
    total += cantidad * pu;
    detalles.push([++detalleId, id, producto_id, cantidad, pu]);
    // PostgreSQL: la reserva y su movimiento (y la liberación si el pedido se canceló)
    reservas.push([id, producto_id, sucursal_id, cantidad, estado === 'CONFIRMADO' ? 'ACTIVA' : 'LIBERADA', segundos(fecha, 1).toISOString()]);
    movSalidas.push([sucursal_id, producto_id, 'SALIDA', cantidad, id, segundos(fecha, 1).toISOString()]);
    if (estado === 'CANCELADO') movSalidas.push([sucursal_id, producto_id, 'LIBERACION', cantidad, id, segundos(fecha, 3).toISOString()]);
    else vendidos.set(`${producto_id}:${sucursal_id}`, (vendidos.get(`${producto_id}:${sucursal_id}`) || 0) + cantidad);
  }
  total = dinero(total);
  pedidos.push([id, cli.id, sucursal_id, mysqlFecha(fecha), total.toFixed(2), estado, null]);
  const d = principal[cli.id];
  pedidoCliente.push([id, d.id, cli.nombre, cli.telefono, d.calle, d.ciudad, d.estado, d.cp, rnd() < 0.3 ? elegir(INSTRUCCIONES) : null]);

  // Mongo: bitácora de la Saga de este pedido
  const ev = (seg, tipo, paso, motor, detalle) =>
    eventos.push({ pedido_id: id, clave_evento: `${id}:${tipo}`, tipo, paso, motor, fecha: segundos(fecha, seg).toISOString(), detalle, origen: 'seed' });
  ev(0, 'PEDIDO_CREADO', 3, 'mysql', { cliente_id: cli.id, sucursal_id, total });
  ev(1, 'INVENTARIO_RESERVADO', 4, 'postgres', { lineas });
  if (estado === 'CONFIRMADO') {
    ev(2, 'PEDIDO_CONFIRMADO', 5, 'mysql', { total });
  } else {
    ev(2, 'CONFIRMACION_FALLIDA', 5, 'mysql', { motivo: 'pago rechazado' });
    ev(3, 'RESERVA_LIBERADA', 5, 'postgres', { compensacion: true });
    ev(4, 'PEDIDO_CANCELADO', 5, 'mysql', { compensacion: true });
  }
}

const sqlMy = ['-- Generado por seed/generar.js. Carga: bash scripts/mysql/datos.sh (en db1)', 'SET NAMES utf8mb4;', 'SET autocommit = 0;'];
mysqlInserts(sqlMy, 'clientes', ['id', 'nombre', 'email', 'telefono', 'fecha_alta'], clientes.map((c) => [c.id, c.nombre, c.email, c.telefono, mysqlFecha(c.fecha_alta)]));
mysqlInserts(sqlMy, 'direcciones', ['id', 'cliente_id', 'calle', 'ciudad', 'estado', 'cp', 'principal'], direcciones.map((d) => [d.id, d.cliente_id, d.calle, d.ciudad, d.estado, d.cp, d.principal]));
mysqlInserts(sqlMy, 'pedidos', ['id', 'cliente_id', 'sucursal_id', 'fecha', 'total', 'estado', 'clave_idempotencia'], pedidos);
mysqlInserts(sqlMy, 'pedido_cliente', ['pedido_id', 'direccion_id', 'destinatario', 'telefono_contacto', 'calle', 'ciudad', 'estado', 'cp', 'instrucciones'], pedidoCliente);
mysqlInserts(sqlMy, 'detalle_pedido', ['id', 'pedido_id', 'producto_id', 'cantidad', 'precio_unitario'], detalles);
sqlMy.push('SET autocommit = 1;');
fs.writeFileSync(path.join(SALIDA, 'mysql.sql'), sqlMy.join('\n') + '\n');

// ---------- PostgreSQL: sucursales, productos_sucursal, inventario, reservas, movimientos ----------
const sqlPg = ['-- Generado por seed/generar.js. Carga: bash scripts/postgres/datos.sh (en db2)', "SET client_encoding = 'UTF8';", 'BEGIN;'];
pgCopy(sqlPg, 'sucursales', ['id', 'nombre', 'ciudad', 'region'], SUCURSALES);
const ps = [], inv = [], movEntradas = [];
const fechaEntrada = new Date('2025-12-15T09:00:00Z').toISOString();
for (const p of productos) {
  for (const [sucursal_id] of SUCURSALES) {
    const entrada = ent(150, 600);
    ps.push([p.producto_id, sucursal_id, precio(p.producto_id, sucursal_id).toFixed(2), 't']);
    inv.push([p.producto_id, sucursal_id, entrada - (vendidos.get(`${p.producto_id}:${sucursal_id}`) || 0), '2026-11-01T00:00:00Z']);
    movEntradas.push([sucursal_id, p.producto_id, 'ENTRADA', entrada, null, fechaEntrada]);
  }
}
pgCopy(sqlPg, 'productos_sucursal', ['producto_id', 'sucursal_id', 'precio_local', 'activo'], ps);
pgCopy(sqlPg, 'inventario', ['producto_id', 'sucursal_id', 'cantidad', 'actualizado'], inv);
pgCopy(sqlPg, 'reservas', ['pedido_id', 'producto_id', 'sucursal_id', 'cantidad', 'estado', 'creado'], reservas);
const movCols = ['sucursal_id', 'producto_id', 'tipo', 'cantidad', 'pedido_id', 'creado'];
pgCopy(sqlPg, 'movimientos', movCols, movEntradas);
pgCopy(sqlPg, 'movimientos', movCols, movSalidas);
sqlPg.push('COMMIT;', 'ANALYZE;');
fs.writeFileSync(path.join(SALIDA, 'postgres.sql'), sqlPg.join('\n') + '\n');

// ---------- MongoDB: catalogo, resenas, carritos, logs_busqueda, eventos ----------
ndjson('catalogo', productos);

const resenas = [];
for (let i = 0; i < N.resenas; i++) {
  const calificacion = elegir([1, 2, 3, 4, 4, 4, 5, 5, 5, 5]);
  resenas.push({
    producto_id: ent(1, N.productos), cliente_id: ent(1, N.clientes), calificacion,
    comentario: elegir(COMENTARIOS[calificacion]), verificada: rnd() < 0.7,
    fecha: fechaEntre(new Date('2026-01-01'), new Date('2026-11-01')).toISOString(),
  });
}
ndjson('resenas', resenas);

const carritos = [];
const conCarrito = new Set();
while (conCarrito.size < N.carritos) conCarrito.add(ent(1, N.clientes));
for (const cliente_id of [...conCarrito].sort((a, b) => a - b)) {
  const items = new Map();
  const n = ent(1, 4);
  while (items.size < n) items.set(ent(1, N.productos), ent(1, 3));
  carritos.push({
    cliente_id, sucursal_id: ent(1, SUCURSALES.length),
    items: [...items].map(([producto_id, cantidad]) => ({ producto_id, cantidad })),
    actualizado: fechaEntre(new Date('2026-10-01'), new Date('2026-11-01')).toISOString(),
  });
}
ndjson('carritos', carritos);

const busquedas = [];
for (let i = 0; i < N.busquedas; i++) {
  const categoria = elegir(NOMBRES_CAT);
  busquedas.push({
    cliente_id: rnd() < 0.2 ? null : ent(1, N.clientes), // 20 % anónimas
    termino: elegir(CATEGORIAS[categoria].tipos).toLowerCase(), categoria,
    resultados: ent(0, 120), sucursal_id: ent(1, SUCURSALES.length), origen: 'seed',
    fecha: fechaEntre(new Date('2026-01-01'), new Date('2026-11-01')).toISOString(),
  });
}
ndjson('logs_busqueda', busquedas);
ndjson('eventos', eventos);

// ---------- Resumen ----------
const suma = (o) => Object.values(o).reduce((a, b) => a + b, 0);
resumen.totales = { mysql: suma(resumen.mysql), postgres: suma(resumen.postgres), mongo: suma(resumen.mongo) };
fs.writeFileSync(path.join(SALIDA, 'resumen.json'), JSON.stringify(resumen, null, 2) + '\n');
for (const motor of ['mysql', 'postgres', 'mongo']) {
  console.log(`${motor.padEnd(9)} ${String(resumen.totales[motor]).padStart(7)}  ` +
    Object.entries(resumen[motor]).map(([k, v]) => `${k}=${v}`).join('  '));
}
