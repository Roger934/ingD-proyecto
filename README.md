# Proyecto Final — Ingeniería de Datos 1

Plataforma distribuida con MySQL, PostgreSQL y MongoDB integrados por una API, con replicación, fragmentación, monitoreo (Prometheus + Grafana) y un simulador de transacciones.

La documentación de diseño y las decisiones (D1, D2…) viven en la bóveda de Obsidian. Este repo tiene solo lo que se ejecuta.

## Roles (D17, D19)

Cada máquina cumple uno o más **roles**. Los roles son hostnames: mover un rol de máquina es cambiar una línea en `hosts/`.

| Rol | Qué corre | Casa | Uni |
|---|---|---|---|
| `base` | node_exporter (una vez por máquina Linux) | todas | todas menos Diego |
| `db1` | MySQL primario · Mongo cfg1 + shardA-1 | VM escritorio | Vladimir |
| `db2` | MySQL réplica · PostgreSQL primario · Mongo cfg2 + shardA-2 | Many | Many |
| `db3` | PostgreSQL standby · Mongo cfg3 + shardA-3 · mongos | laptop de Luis | VM de Lalo |
| `app` | API + simulador · mongos | VM escritorio | laptop de Luis |
| `mon` | Prometheus + Grafana | VM escritorio | Diego (Windows) |

## Estructura

```
hosts/        hosts.casa, hosts.uni (rol → IP)
roles/
  base/       node_exporter
  mon/        Prometheus + Grafana (con dashboard ya cargado)
  db1/ db2/ db3/ app/   (se agregan por etapas)
scripts/      aplicar-hosts.sh, preflight.sh, generar-secretos.sh, verificar.sh
  mysql/ postgres/ mongo/   init-* (y luego failover-*, rejoin-*)
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

## Reglas

- Imágenes con **versión fija**. Nada de `latest`.
- Secretos solo en `.env` (está en `.gitignore`).
- Scripts en LF (`.gitattributes`). Se corren con `bash script.sh`, así no importa si se pierde el permiso de ejecución al copiarlos.
