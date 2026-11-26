#!/usr/bin/env bash
# Laptop de Lalo: db2 + mon (192.168.1.105). Acciones: bash scripts/db2.sh ayuda
exec bash "$(dirname "$0")/interno/equipo.sh" db2 "$@"
