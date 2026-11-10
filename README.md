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
scripts/      aplicar-hosts.sh, y luego init-*, failover-*, rejoin-*
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

## Reglas

- Imágenes con **versión fija**. Nada de `latest`.
- Secretos solo en `.env` (está en `.gitignore`).
- Scripts en LF (`.gitattributes`). Se corren con `bash script.sh`, así no importa si se pierde el permiso de ejecución al copiarlos.
