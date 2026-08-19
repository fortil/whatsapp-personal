#!/usr/bin/env bash
# restore-drill.sh — comprueba que los backups de verdad se restauran: levanta
# un postgres efímero (sin puertos publicados), restaura el dump indicado y
# compara tablas y filas contra la base origen. Un backup sin restauración
# probada es medio backup.
#
#   bash infra/deploy/restore-drill.sh [backups/db-....sql.gz]
#
# Sin argumento toma el más reciente. Corre en la máquina con el stack arriba
# (local o servidor): la base origen se lee por `docker compose exec`.
set -euo pipefail
cd "$(dirname "$0")/../.."
. infra/deploy/lib.sh

DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP=$(ls -1t backups/db-*.sql.gz 2>/dev/null | head -n 1 || true)
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || die "no hay dump: pasa la ruta o corre antes infra/deploy/backup.sh"
log "dump a probar: $DUMP ($(du -h "$DUMP" | cut -f1))"

gzip -t "$DUMP" || die "el gzip está corrupto"

C=wp-restore-drill
# -v: el contenedor no monta ningún volumen con nombre (postgres:16-alpine
# crea uno anónimo para /var/lib/postgresql/data), y sin -v ese volumen queda
# huérfano en cada corrida.
docker rm -f -v "$C" >/dev/null 2>&1 || true
cleanup() {
  docker rm -f -v "$C" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Efímero: sin -p, la única forma de llegar es docker exec.
docker run -d --name "$C" -e POSTGRES_PASSWORD=drill postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$C" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$C" pg_isready -h 127.0.0.1 -U postgres >/dev/null

log "restaurando"
docker exec "$C" psql -U postgres -q -c 'CREATE DATABASE whatsapp_personal'
gunzip -c "$DUMP" | docker exec -i "$C" psql -U postgres -d whatsapp_personal -v ON_ERROR_STOP=1 -q

count_rows() {
  # $1: destino (origen|restaurada), $2: tabla
  # < /dev/null en ambas: este helper corre dentro de un `while read` y
  # psql/docker exec, aunque sea con -T, se comería el stdin del bucle.
  if [ "$1" = origen ]; then
    compose exec -T postgres psql -U postgres -d whatsapp_personal -tAc "SELECT count(*) FROM \"$2\"" < /dev/null
  else
    docker exec -i "$C" psql -U postgres -d whatsapp_personal -tAc "SELECT count(*) FROM \"$2\"" < /dev/null
  fi
}

tables_src=$(compose exec -T postgres psql -U postgres -d whatsapp_personal -tAc \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
[ -n "$tables_src" ] || die "la base origen no tiene tablas: ¿corriste las migraciones?"
tables_dst=$(docker exec "$C" psql -U postgres -d whatsapp_personal -tAc \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")

fail=0
if [ "$tables_src" != "$tables_dst" ]; then
  log "FALLO: las tablas no coinciden"
  log "origen:    $(echo "$tables_src" | tr '\n' ' ')"
  log "restaurada: $(echo "$tables_dst" | tr '\n' ' ')"
  fail=1
else
  n=0
  while IFS= read -r t; do
    src=$(count_rows origen "$t")
    dst=$(count_rows restaurada "$t")
    if [ "$src" = "$dst" ]; then
      printf '  %-26s origen=%-6s restaurada=%-6s OK\n' "$t" "$src" "$dst"
    else
      printf '  %-26s origen=%-6s restaurada=%-6s FALLO\n' "$t" "$src" "$dst"
      fail=1
    fi
    n=$((n + 1))
  done <<<"$tables_src"
  [ "$fail" -eq 0 ] && log "restore drill OK: $n tablas, mismas filas en todas"
fi

if [ "$fail" -ne 0 ]; then
  die "el restore drill falló: este backup NO sirve, revisa antes de borrar nada"
fi
