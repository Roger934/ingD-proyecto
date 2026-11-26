# Proyecto Final — Ingeniería de Datos 1

Tienda con sucursales sobre MySQL, PostgreSQL y MongoDB, distribuidos y replicados en 3 computadoras. Una API reparte cada compra entre los 3 motores (Saga), un vigilante hace el failover y Prometheus + Grafana monitorean todo.

## Máquinas y roles (laboratorio final)

Cada máquina cumple uno o más **roles**. Los roles son nombres de host (`db1`, `db2`, `db3`, `app`, `mon`) definidos en `hosts/hosts.uni`: mover un rol de máquina es cambiar una línea.

| Máquina | IP | Roles | Qué corre | Atajo |
|---|---|---|---|---|
| Laptop de Rogelio | 192.168.1.102 | `db1` + `app` | MySQL · Mongo cfg + shard · API · vigilante · simulador · `mongos` | `bash scripts/db1.sh` |
| PC de escritorio | 192.168.1.105 | `db2` (+ `mon` temporal) | MySQL · PostgreSQL · Mongo cfg + shard · Prometheus · Grafana | `bash scripts/db2.sh` |
| Laptop de Many | 192.168.1.103 | `db3` | PostgreSQL · Mongo cfg + shard · `mongos` | `bash scripts/db3.sh` |

Todos los contenedores usan la red del host: cada servicio escucha en la IP de su máquina. Los primarios de MySQL y PostgreSQL cambian después de una falla; para saber cuál es: `curl -s app:8090/estado`.

## Carpetas

```
api/          API (Express), Saga de POST /compras y vigilante
simulador/    compras automáticas con reporte
roles/<rol>/  un docker-compose.yml por rol: base, db1, db2, db3, app, mon
db/           esquemas: mysql/schema.sql, postgres/schema.sql, mongo/init.js
seed/         generador determinista de datos (datos/ no va a git)
hosts/        rol → IP (hosts.uni para el laboratorio)
scripts/      atajos por máquina (ver abajo); scripts/interno/ los usan los atajos
secretos/     contraseñas y keyfile (los crea generar-secretos.sh, NO van a git)
```

## Montar desde cero

En cada máquina, dentro de `~/ingdatos`:

```bash
git clone https://github.com/Roger934/ingD-proyecto.git ~/ingdatos   # una vez, con internet
bash scripts/generar-secretos.sh   # en db1 los crea; en db2 y db3, después de copiar secretos/ de db1
```

Luego, en las 3 máquinas a la vez (cada una espera sola a las otras):

```bash
bash scripts/db1.sh reiniciar    # laptop de Rogelio
bash scripts/db2.sh reiniciar    # PC de escritorio
bash scripts/db3.sh reiniciar    # laptop de Many
```

Cuando db2 y db3 digan listo, en la laptop de Rogelio: `bash scripts/db1.sh app` (levanta la API, revisa primarios, hace una compra y 100 compras).

`reiniciar` = `limpiar` (pide "si") + `preparar` (hosts y preflight) + `levantar` (compose y firewall) + `montar` (replicación y datos).

## Atajos

`bash scripts/<db1|db2|db3>.sh <acción>`; `ayuda` muestra la lista.

| Acción | Qué hace |
|---|---|
| `estado` | IP, hora, contenedores y primarios |
| `revisar` | Replicación y conteos de las bases de esa máquina |
| `pedidos [n]` | Últimos pedidos y su recorrido por los 3 motores |
| `fragmentacion` | JOIN de los fragmentos de MySQL, EXPLAIN con pruning en PostgreSQL, chunks de Mongo |
| `compra` | Una compra de prueba por la API |
| `prueba` | (db1) Carga de 2 min a 10 compras/s, para tirar un servicio mientras corre |
| `falla <motor> [s]` | Detiene un motor de esa máquina s segundos (60) y lo vuelve a arrancar |
| `acomodar` | Regresa los primarios a su lugar y reengancha un PostgreSQL cercado |
| `hora ['AAAA-MM-DD HH:MM:SS']` | Ajusta la hora (sin internet, a mano) |
| `apagar` | (db1) Detiene la app antes de apagar las máquinas |

Además: `bash scripts/simular.sh --n 100` o `--tps 10 --minutos 2` (en db1) para generar carga, y `bash scripts/generar-secretos.sh`. Todo lo de `scripts/interno/` lo llaman los atajos; ahí están también los pasos por motor (`mysql/`, `postgres/`, `mongo/`: `init-*`, `esquema`, `datos`, `rejoin`).

## Monitoreo

En la máquina de `mon`: `roles/mon/.env` (contraseña de Grafana y las IPs de db1, db2, db3 y app) y `cd roles/mon && docker compose up -d`. Prometheus lee cada 5 s los exporters de cada máquina, la API (`app:8080/metrics`) y el vigilante (`app:8090/metrics`): 16 destinos en `http://<mon>:9090/targets`. Grafana en `http://<mon>:3000` con los dashboards Nodos, Replicación y Compras.

## Datos

| Motor | Tablas / colecciones | Fragmentación | Registros |
|---|---|---|---|
| MySQL | clientes, direcciones, **pedidos**, **pedido_cliente**, detalle_pedido | vertical: Pedido = `pedidos ⋈ pedido_cliente` por la misma PK (vista `pedido_completo`) | ~73k |
| PostgreSQL | sucursales, productos_sucursal, **inventario**, reservas, **movimientos** | horizontal: `PARTITION BY LIST (sucursal_id)`, 5 fragmentos | ~110k |
| MongoDB | **catalogo**, resenas, carritos, logs_busqueda, **eventos** | sharding hashed de `catalogo.producto_id` y `eventos.pedido_id` | ~88k |

`seed/generar.js` es determinista: cada máquina genera los mismos datos, así que los IDs coinciden en los 3 motores.

## API

Rutas: `POST /compras` · `GET /pedidos` · `GET /pedidos/:id` (desde los 3 motores) · `GET /inventario/:sucursal` · `PUT /carritos/:cliente` · `GET /productos/:id` · `GET /salud` · `GET /metrics`.

```bash
curl -s -X POST http://app:8080/compras -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"cliente_id":1,"sucursal_id":1,"items":[{"producto_id":1,"cantidad":2},{"producto_id":8,"cantidad":1}]}'
```

Repetir la misma `Idempotency-Key` devuelve el pedido original sin duplicarlo.

**Saga de la compra** (`api/src/saga.js`):

| Paso | Motor | Acción | Si falla |
|---|---|---|---|
| 1 | Mongo | carritos, catalogo, logs_busqueda | abortar |
| 2 | PostgreSQL | sucursales y productos_sucursal (precio local, solo lectura) | abortar |
| 3 | MySQL | clientes, direcciones → pedidos (PENDIENTE), pedido_cliente, detalle_pedido | abortar |
| 4 | PostgreSQL | inventario −, reservas, movimientos (SALIDA) | pedido → CANCELADO |
| 5 | MySQL | pedido → CONFIRMADO | liberar reserva (LIBERACION) y pedido → CANCELADO |
| 6 | Mongo | eventos, vaciar carrito, resenas | reintentar (idempotente) |

## Failover (vigilante)

`api/src/vigilante.js` (contenedor `vigilante-app`) revisa MySQL y PostgreSQL cada 2 s y promueve al respaldo si el primario no responde en 5 revisiones (~10 s). Mongo elige su primario solo (replica sets de 3 miembros) y la API tiene dos `mongos`.

Para evitar dos primarios, **ningún nodo se vuelve primario solo**: MySQL arranca en solo lectura y PostgreSQL como standby; el vigilante promueve. Un primario viejo que regresa queda en solo lectura (cercado) y se reengancha como réplica. PostgreSQL cercado: `bash scripts/db<N>.sh acomodar` en esa máquina. MySQL con transacciones que el primario no tiene: `bash scripts/interno/mysql/rejoin.sh <primario> --reconstruir`.

## Reglas

- Imágenes con **versión fija**. Nada de `latest`.
- Secretos solo en `secretos/` y `.env` (en `.gitignore`).
- Scripts en LF (`.gitattributes`). Se corren con `bash script.sh`.
