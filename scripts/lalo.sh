#!/usr/bin/env bash
# PC de escritorio: db2 + mon temporal (192.168.1.105). Acciones: bash scripts/lalo.sh ayuda
exec bash "$(dirname "$0")/equipo.sh" lalo "$@"
