#!/usr/bin/env bash
# Laptop de Rogelio: db1 + app (192.168.1.102). Acciones: bash scripts/db1.sh ayuda
exec bash "$(dirname "$0")/interno/equipo.sh" db1 "$@"
