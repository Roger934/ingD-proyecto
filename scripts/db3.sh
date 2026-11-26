#!/usr/bin/env bash
# Laptop de Many: db3 (192.168.1.103). Acciones: bash scripts/db3.sh ayuda
exec bash "$(dirname "$0")/interno/equipo.sh" db3 "$@"
