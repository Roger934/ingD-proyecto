# Proyecto Final — Ingeniería de Datos 1

Tienda con sucursales sobre MySQL, PostgreSQL y MongoDB, distribuidos y replicados en 3 computadoras. Una API reparte cada compra entre los 3 motores (Saga), un vigilante hace el failover y Prometheus + Grafana monitorean todo.

## Nodos y roles

Cada nodo cumple uno o más **roles**. Los roles son nombres de host (`db1`, `db2`, `db3`, `app`, `mon`) definidos en `hosts/hosts.uni`: mover un rol a otro nodo es cambiar una línea.

| Nodo | Equipo | IP | Roles | Qué corre | Atajo |
|---|---|---|---|---|---|
| Nodo 1 | Laptop de Rogelio | 192.168.1.102 | `db1` + `app` | MySQL · Mongo cfg + shard · `mongos` · API · vigilante · simulador | `scripts/db1.sh` |
| Nodo 2 | Laptop de Lalo | 192.168.1.105 | `db2` + `mon` | MySQL · PostgreSQL · Mongo cfg + shard · Prometheus · Grafana | `scripts/db2.sh` |
| Nodo 3 | Laptop de Many | 192.168.1.103 | `db3` | PostgreSQL · Mongo cfg + shard · `mongos` | `scripts/db3.sh` |

Todos los contenedores usan la red del host: cada servicio escucha en la IP de su nodo. Los primarios de MySQL y PostgreSQL cambian después de una falla; para saber cuál es: `bash scripts/db1.sh estado`.

## Carpetas

```
api/          API (Express), Saga de POST /compras y vigilante
simulador/    compras automáticas con reporte
roles/<rol>/  un docker-compose.yml por rol: base, db1, db2, db3, app, mon
db/           esquemas: mysql/schema.sql, postgres/schema.sql, mongo/init.js
seed/         generador determinista de datos (datos/ no va a git)
hosts/        rol → IP (hosts.uni para el laboratorio)
scripts/      atajos por nodo (ver abajo); scripts/interno/ los usan los atajos
secretos/     contraseñas y keyfile (los crea generar-secretos.sh, NO van a git)
```

## Montar desde cero

Todos los comandos se corren dentro de `~/ingdatos`.

### 1. Requisitos (cada nodo, con internet)

```bash
sudo apt install -y git curl wget jq docker.io docker-compose-v2
sudo usermod -aG docker $USER          # cerrar sesión y volver a entrar
git clone https://github.com/Roger934/ingD-proyecto.git ~/ingdatos
```

En el laboratorio no hay internet: bajar antes las imágenes (`docker pull`; las versiones están en los compose de `roles/`).

### 2. Red

En el módem (`http://192.168.1.254`), reservar una IP por MAC: nodo 1 → `.102`, nodo 2 → `.105`, nodo 3 → `.103`. Cada nodo revisa la suya con `ip -4 -br addr`.

### 3. Secretos (no van a git)

Nodo 1, los genera y los comparte:

```bash
bash scripts/generar-secretos.sh
mkdir -p ~/compartir && tar czf ~/compartir/secretos.tgz secretos
sudo ufw allow from 192.168.1.0/24 to any port 8000 proto tcp
cd ~/compartir && python3 -m http.server 8000
```

Nodos 2 y 3, los bajan y los validan (debe decir "Secretos completos y válidos"):

```bash
wget http://192.168.1.102:8000/secretos.tgz && tar xzf secretos.tgz && rm secretos.tgz
bash scripts/generar-secretos.sh
```

Al terminar, en el nodo 1: Ctrl+C, `sudo ufw delete allow from 192.168.1.0/24 to any port 8000 proto tcp` y `rm -rf ~/compartir`.

### 4. Montar (los tres a la vez; cada uno espera a los otros)

```bash
bash scripts/db1.sh reiniciar    # nodo 1
bash scripts/db2.sh reiniciar    # nodo 2
bash scripts/db3.sh reiniciar    # nodo 3
```

Cuando los nodos 2 y 3 digan listo, en el nodo 1: `bash scripts/db1.sh app` (levanta la API, revisa primarios, hace una compra y 100 compras).

`reiniciar` = `limpiar` (pide "si") + `preparar` (hosts y preflight) + `levantar` (compose y firewall) + `montar` (replicación y datos).

## Guía rápida

| Si quieres… | Dónde | Comando | Para regresar |
|---|---|---|---|
| Ver que todo esté bien | cada nodo | `bash scripts/dbN.sh estado` y `revisar` | — |
| Meter una compra | nodo 1 | `bash scripts/db1.sh compra` | — |
| Ver los últimos pedidos | nodo 1 | `bash scripts/db1.sh pedidos 5` | — |
| Generar carga | nodo 1 | `bash scripts/simular.sh --n 100` | — |
| Tirar el primario de MySQL | nodo 1 | `bash scripts/db1.sh falla mysql 60` | nodo 2: `bash scripts/db2.sh acomodar` |
| Tirar el primario de PostgreSQL | nodo 2 | `bash scripts/db2.sh falla postgres 60` | nodo 3: `bash scripts/db3.sh acomodar` |
| Tirar el primario de MongoDB | nodo 1 | `bash scripts/db1.sh falla mongo 60` | vuelve solo |
| Tirar un mongos | nodo 3 | `bash scripts/db3.sh falla mongos 60` | vuelve solo |
| Apagar todo | nodo 1 primero | `bash scripts/db1.sh apagar` | prender nodos 2 y 3, luego `bash scripts/db1.sh app` |

Antes de una prueba de falla: `bash scripts/db1.sh prueba` en el nodo 1, para tener carga y un reporte al final (debe decir 0 errores y 20/20).

## Atajos

`bash scripts/<db1|db2|db3>.sh <acción>`; `ayuda` muestra la lista.

| Acción | Qué hace |
|---|---|
| `estado` | IP, hora, contenedores y primarios |
| `revisar` | Replicación y conteos de las bases de ese nodo |
| `pedidos [n]` | Últimos pedidos y su recorrido por los 3 motores |
| `fragmentacion` | JOIN de los fragmentos de MySQL, EXPLAIN con pruning en PostgreSQL, chunks de Mongo |
| `compra` | Una compra de prueba por la API |
| `prueba` | (db1) Carga de 2 min a 10 compras/s, para tirar un servicio mientras corre |
| `falla <motor> [s]` | Detiene un motor de ese nodo s segundos (60) y lo vuelve a arrancar |
| `acomodar` | Regresa los primarios a su lugar y reengancha un PostgreSQL cercado |
| `hora ['AAAA-MM-DD HH:MM:SS']` | Ajusta la hora (sin internet, a mano) |
| `apagar` | (db1) Detiene la app antes de apagar los nodos |

Además: `bash scripts/simular.sh --n 100` o `--tps 10 --minutos 2` (en el nodo 1) para generar carga, y `bash scripts/generar-secretos.sh`. Todo lo de `scripts/interno/` lo llaman los atajos; ahí están también los pasos por motor (`mysql/`, `postgres/`, `mongo/`: `init-*`, `esquema`, `datos`, `rejoin`).

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| `mysql-db1` se reinicia: puerto 3306 ocupado | `sudo systemctl disable --now mysql` |
| Un script se queda en "Esperando: dbN alcanzable" | Revisar la IP (`ip -4 -br addr`) y el firewall del rol |
| PostgreSQL CERCADO en `estado` | `bash scripts/dbN.sh acomodar` en ese nodo |
| Grafana "No data" sin internet | Hora mal: `bash scripts/dbN.sh hora 'AAAA-MM-DD HH:MM:SS'` |
| No hay failover al tirar un primario | La réplica ya estaba cercada: `acomodar` antes de la prueba |

## Monitoreo

En el nodo de `mon`: `roles/mon/.env` (contraseña de Grafana y las IPs de db1, db2, db3 y app) y `cd roles/mon && docker compose up -d`. Prometheus lee cada 5 s los exporters de cada nodo, la API (`app:8080/metrics`) y el vigilante (`app:8090/metrics`): 16 destinos en `http://<mon>:9090/targets`. Grafana en `http://<mon>:3000` con los dashboards Nodos, Replicación y Compras.

## Datos

| Motor | Tablas / colecciones | Fragmentación | Registros |
|---|---|---|---|
| MySQL | clientes, direcciones, **pedidos**, **pedido_cliente**, detalle_pedido | vertical: Pedido = `pedidos ⋈ pedido_cliente` por la misma PK (vista `pedido_completo`) | ~73k |
| PostgreSQL | sucursales, productos_sucursal, **inventario**, reservas, **movimientos** | horizontal: `PARTITION BY LIST (sucursal_id)`, 5 fragmentos | ~110k |
| MongoDB | **catalogo**, resenas, carritos, logs_busqueda, **eventos** | sharding hashed de `catalogo.producto_id` y `eventos.pedido_id` | ~88k |

`seed/generar.js` es determinista: cada nodo genera los mismos datos, así que los IDs coinciden en los 3 motores.

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

Para evitar dos primarios, **ningún nodo se vuelve primario solo**: MySQL arranca en solo lectura y PostgreSQL como standby; el vigilante promueve. Un primario viejo que regresa queda en solo lectura (cercado) y se reengancha como réplica. PostgreSQL cercado: `bash scripts/dbN.sh acomodar` en ese nodo. MySQL con transacciones que el primario no tiene: `bash scripts/interno/mysql/rejoin.sh <primario> --reconstruir`.

## Reglas

- Imágenes con **versión fija**. Nada de `latest`.
- Secretos solo en `secretos/` y `.env` (en `.gitignore`).
- Scripts en LF (`.gitattributes`). Se corren con `bash script.sh`.
