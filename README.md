# Proyecto Final — Ingeniería de Datos 1

Plataforma distribuida con MySQL, PostgreSQL y MongoDB integrados por una API, con replicación, fragmentación, monitoreo (Prometheus + Grafana) y un simulador de transacciones.

La documentación de diseño y las decisiones (D1, D2…) viven en la bóveda de Obsidian. Este repo tiene solo lo que se ejecuta.

## Roles (D17, D19)

Cada máquina cumple uno o más **roles**. Los roles son hostnames: mover un rol de máquina es cambiar una línea en `hosts/`.

| Rol | Qué corre | Casa | Uni |
|---|---|---|---|
| `base` | node_exporter (una vez por máquina Linux) | todas | todas menos Diego |
| `db1` | MySQL primario · Mongo cfg1 + shardA-1 | VM escritorio | Vladimir |
| `db2` | MySQL réplica · PostgreSQL primario · Mongo cfg2 + shardA-2 | Many | Lalo |
| `db3` | PostgreSQL standby · Mongo cfg3 + shardA-3 · mongos | laptop de Luis | Many |
| `app` | API + simulador · mongos | VM escritorio | laptop de Luis |
| `mon` | Prometheus + Grafana | VM escritorio | Diego (Windows) |

## Estructura

```
hosts/        hosts.casa, hosts.uni (rol → IP)
roles/
  base/       node_exporter
  mon/        Prometheus + Grafana (dashboards Nodos, Replicación y Compras ya cargados)
  db1/ db2/ db3/   bases de datos de cada rol
  app/        API + mongos
db/           esquemas: mysql/schema.sql, postgres/schema.sql, mongo/init.js
seed/         generar.js (catálogo maestro + seeds); datos/ se genera y NO va a git
api/          API en Node (Express): conexiones tolerantes a fallas y Saga de POST /compras
simulador/    simulador.js: compras automáticas con reporte (D26)
scripts/      aplicar-hosts.sh, preflight.sh, generar-secretos.sh, verificar.sh,
              generar-datos.sh, conteos.sh, probar-compra.sh, demo-fragmentacion.sh, simular.sh
  mysql/ postgres/ mongo/   init-*, esquema.sh, datos.sh (y luego failover-*, rejoin-*)
secretos/     contraseñas y keyFile (lo crea generar-secretos.sh, NO va a git)
```

## Etapa 1 — Monitoreo de las máquinas

### En cada máquina Linux
```bash
bash scripts/aplicar-hosts.sh casa
cd roles/base && docker compose up -d
curl -s localhost:9100/metrics | head -3
```

### En la máquina con el rol `mon`
```bash
cd roles/mon
cp .env.example .env      # y cambia GRAFANA_ADMIN_PASSWORD
docker compose up -d
```
- Prometheus: `http://mon:9090/targets` → todos los destinos en **UP**.
- Grafana: `http://mon:3000` (usuario `admin`) → dashboard **Plataforma — Nodos**.

Desde Windows, en lugar de `mon` usa la IP (por ejemplo `http://192.168.1.101:3000`).

## Etapa 2 — Replicación de los 3 motores

Necesita las **3 máquinas de BD encendidas** (db1, db2 y db3): Mongo no inicia un replica set si falta un miembro.

**0. Una sola vez, en Windows (Git Bash) o en cualquier máquina:**
```bash
bash scripts/generar-secretos.sh   # crea secretos/ y los .env de cada rol (no se suben a git)
```
Luego copia el repo completo (con `secretos/`) a las máquinas.

**1. En cada máquina:** hosts, revisión y levantar sus roles.
```bash
bash scripts/aplicar-hosts.sh casa
bash scripts/preflight.sh db1 app mon        # los roles de ESA máquina
cd roles/db1 && docker compose up -d         # repetir por cada rol de la máquina
```

**2. Inicializar, en este orden:**

| # | Dónde | Comando | Qué hace |
|---|---|---|---|
| 1 | db1 | `bash scripts/mysql/init-primario.sh` | Base `ecommerce` y usuarios repl/exporter/app |
| 2 | db2 | `bash scripts/mysql/init-replica.sh` | Réplica por GTID con SSL, y la deja en solo lectura |
| 3 | db2 | `bash scripts/postgres/init-primario.sh` | Roles y slot `standby_db3` |
| 4 | db3 | `bash scripts/postgres/init-standby.sh` | `pg_basebackup` desde db2 y arranque del standby |
| 5 | db1 | `bash scripts/mongo/init-replsets.sh` | `cfgRS` y `shardA` (db1 primario) y usuarios |
| 6 | db3 | `bash scripts/mongo/init-sharding.sh` | `addShard`, usuarios del clúster, sharding de `catalogo` y `eventos` |

Todos se pueden repetir sin romper nada.

**3. Comprobar:**
```bash
bash scripts/verificar.sh            # en cada máquina: estado de lo que corre ahí
```
En `mon`, recarga Prometheus para que lea los nuevos destinos: `docker compose restart prometheus`.
En Grafana aparece el dashboard **Plataforma — Replicación**.

> En db3, el PostgreSQL standby **no** arranca con `docker compose up -d` (perfil `standby`). Lo crea y lo arranca `init-standby.sh`. Para reiniciarlo a mano: `docker compose --profile standby up -d postgres`.

## Etapa 3 — Datos y API

Necesita la etapa 2 funcionando (`bash scripts/verificar.sh` sano en las 3 máquinas).

**Modelo** (fragmentación de cada motor):

| Motor | Tablas / colecciones | Fragmentación | Registros |
|---|---|---|---|
| MySQL | clientes, direcciones, **pedidos**, **pedido_cliente**, detalle_pedido | vertical: Pedido = `pedidos ⋈ pedido_cliente` por la misma PK (vista `pedido_completo`) | ~73k |
| PostgreSQL | sucursales, productos_sucursal, **inventario**, reservas, **movimientos** | horizontal: `PARTITION BY LIST (sucursal_id)`, 5 fragmentos | ~110k |
| MongoDB | **catalogo**, resenas, carritos, logs_busqueda, **eventos** | sharding hashed de `catalogo.producto_id` y `eventos.pedido_id` | ~88k |

Los seeds salen de `seed/generar.js`, que es **determinista**: cada máquina genera los mismos datos (con su Node o con un contenedor `node:22.12.0`), así que los `producto_id`, `cliente_id`, `sucursal_id` y `pedido_id` coinciden en los 3 motores.

**1. Esquema y datos (cada script crea el esquema si falta y luego carga):**

| # | Dónde | Comando |
|---|---|---|
| 1 | db1 | `bash scripts/mysql/datos.sh` |
| 2 | db2 | `bash scripts/postgres/datos.sh` |
| 3 | db3 o app | `bash scripts/mongo/datos.sh` |

Con `--reiniciar` borran todo y cargan de nuevo. Las réplicas reciben los datos solas: `bash scripts/conteos.sh` en db2 y db3 lo comprueba.

**2. API (máquina con el rol `app`):**
```bash
cd roles/app && docker compose up -d --build
curl -s localhost:8080/salud
```
En `mon`: `docker compose restart prometheus` para que aparezca el destino `api`.

**3. Probar una compra de punta a punta:**
```bash
bash scripts/probar-compra.sh          # compra, repetición idempotente, carrito, stock insuficiente con compensación
bash scripts/demo-fragmentacion.sh     # JOIN de MySQL, EXPLAIN con pruning, reparto de chunks
```

**Endpoints:** `GET /salud` · `POST /compras` · `GET /pedidos/:id` (desde los 3 motores) · `GET /inventario/:sucursal?producto_id=1,2` · `GET /productos/:id` · `GET /metrics`.

`POST /compras` recibe `{ cliente_id, sucursal_id, items?: [{ producto_id, cantidad }], resena?: { calificacion, comentario } }` y el encabezado opcional `Idempotency-Key`. Sin `items`, compra lo que hay en el carrito del cliente.

**Saga de la compra** (`api/src/saga.js`):

| Paso | Motor | Acción | Si falla |
|---|---|---|---|
| 1 | Mongo | carritos, catalogo, logs_busqueda | abortar |
| 2 | PostgreSQL | sucursales y productos_sucursal (precio local, solo lectura) | abortar |
| 3 | MySQL | clientes, direcciones → pedidos (PENDIENTE), pedido_cliente, detalle_pedido | abortar |
| 4 | PostgreSQL | inventario −, reservas, movimientos (SALIDA) | pedido → CANCELADO |
| 5 | MySQL | pedido → CONFIRMADO | liberar reserva (LIBERACION) y pedido → CANCELADO |
| 6 | Mongo | eventos, vaciar carrito, resenas | reintentar (idempotente) |

## Etapa 4 — Failover automático (D25, D27)

El **vigilante** (`api/src/vigilante.js`, contenedor `vigilante-app` del rol `app`) revisa MySQL y PostgreSQL cada 2 s y promueve al respaldo si el primario deja de responder (~10–15 s). Estado: `curl -s app:8090/estado`.

**Regla contra el split brain: ningún nodo se vuelve primario solo.**
- MySQL arranca siempre en **solo lectura** (`SET PERSIST_ONLY super_read_only`). El vigilante lo habilita con `SET GLOBAL`, que no se persiste.
- PostgreSQL arranca siempre como **standby** (`roles/db*/postgres/arranque.sh` crea `standby.signal`). El vigilante lo promueve con `pg_promote()`.
- Un primario caído que regresa queda en solo lectura:
  - MySQL: el vigilante lo reengancha como réplica si sus GTID son un subconjunto de los del nuevo primario.
  - PostgreSQL: vuelve solo como standby; si divergió, `rejoin.sh`.
- Si aparecen dos primarios, el vigilante cerca al que no es oficial (`super_read_only` / `default_transaction_read_only`).
- Sin replication slots: `wal_keep_size=1GB`.

| Qué cae | Qué hace el vigilante |
|---|---|
| Primario MySQL | promueve a la réplica que lo seguía; al volver, el viejo queda como réplica |
| Primario PostgreSQL | promueve al standby que lo seguía; el viejo vuelve como standby |
| Reinicio rápido del primario | lo vuelve a habilitar (no hay failover) |
| Reinicio de todo | habilita al último primario conocido (`/estado` en un volumen) |

Respaldo manual, por si el vigilante no está:

| Script | Dónde | Qué hace |
|---|---|---|
| `bash scripts/mysql/failover.sh` | máquina a promover | promueve su MySQL |
| `bash scripts/mysql/rejoin.sh <primario> [--reconstruir]` | máquina que regresa | réplica por GTID; con `--reconstruir`, la borra y la copia de nuevo |
| `bash scripts/postgres/failover.sh` | máquina a promover | `pg_promote()` |
| `bash scripts/postgres/rejoin.sh <primario>` | máquina que regresa | la vuelve a copiar con `pg_basebackup` |

Prueba de la lógica sin bases (clúster simulado en memoria): `cd api && npm run probar-vigilante`.

## Etapa 4 — Simulador de transacciones (D26)

`simulador/simulador.js` compra por HTTP a la API sin intervención manual. Es Node puro, sin dependencias, y corre en el contenedor `simulador-app` del rol `app` (perfil `simulador`: **no** arranca con `up -d`).

```bash
bash scripts/simular.sh --n 100                  # 100 compras, 10 en paralelo
bash scripts/simular.sh --n 1000 --concurrencia 20
bash scripts/simular.sh --tps 20 --minutos 5     # carga constante: para las pruebas de falla
bash scripts/simular.sh --n 100 --json > reporte.json
bash scripts/simular.sh --ayuda
```

| Modo | Para qué |
|---|---|
| `--n N [--concurrencia C]` | Cargas de "decenas, cientos o miles": 10 / 100 / 1000 compras lo más rápido posible |
| `--tps X --minutos T` | Ritmo constante mientras se tiran servicios: muestra cuánto dura la interrupción |

Mezcla de compras (configurable): 30 % desde el carrito (`PUT /carritos` y luego `POST /compras` sin items), 10 % con reseña y 5 % que piden 1000 piezas (el inventario máximo es 600), así que **la Saga compensa** y el pedido queda CANCELADO.

Si la API responde 5xx o no responde, la compra se **reintenta con la misma `Idempotency-Key`** (hasta `--reintentar-hasta`, 60 s). Si la compra sí se había hecho, la API devuelve el pedido original: no hay duplicados.

**Reporte al terminar** (también con Ctrl+C):
- confirmadas, compensadas, rechazadas, errores, reintentos y recuperadas por idempotencia;
- compras confirmadas por segundo; latencia p50/p95/p99 por petición y por compra (con reintentos);
- **segundos sin servicio** y sus ventanas (hora de inicio y fin), y los primarios antes y después según el vigilante;
- **consistencia**: revisa una muestra de pedidos con `GET /pedidos/:id` en los 3 motores (estado en MySQL, reservas en PostgreSQL, eventos en Mongo).

Sale con código 0 si no hubo errores y la muestra es consistente, y 1 si no.

En Grafana, el dashboard **Plataforma — Compras** muestra en vivo: compras/s por resultado, latencia, compensaciones, fallas por paso de la Saga y el primario de cada motor.

## Reglas

- Imágenes con **versión fija**. Nada de `latest`.
- Secretos solo en `.env` (está en `.gitignore`).
- Scripts en LF (`.gitattributes`). Se corren con `bash script.sh`, así no importa si se pierde el permiso de ejecución al copiarlos.
