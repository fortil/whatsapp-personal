#!/usr/bin/env bash
# rollback.sh — volver a un sha ya publicado. Manual, para cuando el deploy
# automático no alcanzó o el problema se descubrió tarde:
#
#   TAG=<sha> bash infra/deploy/rollback.sh
#
# (TAG=latest para volver a la última publicada.) El sha tiene que existir en
# ghcr.io: el workflow etiqueta cada build con su sha justo para esto.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/deploy/lib.sh

export TAG="${TAG:-latest}"
export IMAGE_OWNER="${IMAGE_OWNER:-fortil}"
[ -f .env ] || die "no hay .env en la raíz (docs/despliegue.md)"

log "rollback a TAG=$TAG"
log "pull de esa versión (debe existir en ghcr.io)"
compose pull -q api worker panel

log "recreando servicios"
compose up -d --no-build api worker panel

health_gate api && health_gate worker && health_gate panel || die "el rollback no pasó el gate de salud: docker compose logs api worker panel"
log "rollback completado con $TAG healthy"
