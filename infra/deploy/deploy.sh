#!/usr/bin/env bash
# deploy.sh — despliegue en el servidor ECS. Lo llama el workflow de GitHub
# Actions por SSH, pero también se puede correr a mano:
#
#   TAG=<sha> IMAGE_OWNER=<owner> bash infra/deploy/deploy.sh
#
# Orden (el del plan): backup → migraciones (forward-only, ANTES del
# rollout) → pull + up → gate de salud → rollback automático si el gate
# falla (re-etiqueta la imagen anterior y recrea).
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/deploy/lib.sh

export TAG="${TAG:-latest}"
export IMAGE_OWNER="${IMAGE_OWNER:-fortil}"
[ -f .env ] || die "no hay .env en la raíz: cópialo de .env.example y llénalo (docs/despliegue.md)"

log "deploy TAG=$TAG IMAGE_OWNER=$IMAGE_OWNER"

if [ -n "$(compose ps -q postgres)" ]; then
  log "backup antes de tocar nada"
  bash infra/deploy/backup.sh
else
  log "sin base todavía: primer despliegue, no hay nada que respaldar"
fi

# Referencias de las imágenes que corren ahora: el seguro de vida del
# rollback. Se capturan ANTES del pull para que no las pise nada.
prev_api=$(running_image api)
prev_worker=$(running_image worker)
prev_panel=$(running_image panel)
log "imágenes actuales: api=${prev_api:-(primera)} worker=${prev_worker:-(primera)} panel=${prev_panel:-(primera)}"

log "pull de las imágenes nuevas"
compose pull -q api worker panel

log "migraciones drizzle (forward-only, antes del rollout)"
# -T: por SSH no interactivo sin TTY. La migración corre en la imagen de la
# api, que ya trae packages/db/dist/migrate.js compilado.
compose run --rm -T api node packages/db/dist/migrate.js

log "rollout"
compose up -d --remove-orphans

if health_gate api && health_gate worker && health_gate panel; then
  log "deploy completado"
  exit 0
fi

log "el gate de salud falló: rollback automático re-etiquetando la imagen anterior"
if [ -z "$prev_api$prev_worker$prev_panel" ]; then
  die "primera instalación (no hay imagen previa): revisa los logs con 'docker compose logs api'"
fi

rollback_retag() {
  local prev=$1 svc=$2
  local new="ghcr.io/${IMAGE_OWNER}/wp-${svc}:${TAG}"
  if [ -n "$prev" ] && [ "$prev" != "$new" ]; then
    docker tag "$prev" "$new"
    log "re-etiquetada $prev -> $new"
  fi
}
rollback_retag "$prev_api" api
rollback_retag "$prev_worker" worker
rollback_retag "$prev_panel" panel

log "recreando con las imágenes anteriores"
# --no-build y sin pull: $TAG ahora apunta localmente a la imagen vieja
compose up -d --no-build api worker panel

health_gate api && health_gate worker && health_gate panel || die "el rollback tampoco pasó el gate: intervención manual (docker compose logs api worker panel)"
log "rollback completado: la versión anterior sigue sirviendo"
exit 1
