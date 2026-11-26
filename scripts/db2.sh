#!/usr/bin/env bash
# PC de escritorio: db2 + mon temporal (192.168.1.105). Acciones: bash scripts/db2.sh ayuda
exec bash "$(dirname "$0")/interno/equipo.sh" db2 "$@"
