#!/usr/bin/env bash
# backup.sh — volcado diario de la base de la app, comprimido, con rotación
# de 14 días. Lo instala el cron del servidor (docs/despliegue.md) y lo llama
# deploy.sh antes de cada rollout.
#
# La base `evolution` no se respalda: su contenido se reconstruye del
# teléfono al vincular; lo caro de perder vive en `whatsapp_personal`.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/deploy/lib.sh

mkdir -p backups
stamp=$(date -u +%Y%m%d-%H%M%S)
dest="backups/db-$stamp.sql.gz"
tmp="$dest.tmp"

# Si el script muere por señal (reinicio a mitad del cron, timeout), el
# temporal no debe sobrevivir: ni la rotación (glob db-*.sql.gz) ni el
# restore drill lo ven, así que quedaría para siempre sin que nadie lo note.
trap 'rm -f "$tmp"' EXIT

# -T por SSH; pg_dump del propio contenedor evita instalar cliente y que
# cliente/servidor discrepen de versión.
# Se escribe primero a un temporal: si pg_dump falla a mitad de camino,
# pipefail hace caer el if, se borra el temporal y "$dest" nunca existe con
# contenido basura. Sin esto, un .gz vacío pasaba por "el backup más reciente"
# para restore-drill.sh y ocupaba un hueco de la rotación de 14 días.
if compose exec -T postgres pg_dump -U postgres -d whatsapp_personal | gzip > "$tmp"; then
  mv "$tmp" "$dest"
  log "backup escrito: $dest ($(du -h "$dest" | cut -f1))"
else
  rm -f "$tmp"
  die "pg_dump falló: no se escribió backup nuevo (docker compose logs postgres)"
fi

# rotación: quedan los 14 más recientes
ls -1t backups/db-*.sql.gz 2>/dev/null | tail -n +15 | while IFS= read -r old; do
  rm -f "$old"
  log "rotado fuera: $old"
done
