# Funciones compartidas por los scripts de infra/deploy. Se sourcea desde la
# raíz del repo (en el servidor, /opt/whatsapp-personal): cada script hace
# `cd` antes de sourcear.
#
# Lecciones de operativa que aquí quedan fijadas:
# - Toda interacción con contenedores por SSH no interactivo lleva -T (sin
#   TTY), o el pipe se come el stdin y el comando queda vacío sin error.

# El stack completo siempre es base + overlay: así los scripts ven los mismos
# nombres de servicio que producción, aunque postgres/redis estén levantados
# solo con la base (el project name sale del directorio, es el mismo).
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.prod.yml)

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

# Imagen que corre hoy en un servicio (vacío si el servicio no existe).
# Es la referencia completa, ej. ghcr.io/fortil/wp-api:abc123 — lo que
# permite re-etiquetar para el rollback.
running_image() {
  local id
  id=$(compose ps -q "$1" 2>/dev/null || true)
  [ -n "$id" ] || return 0
  docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true
}

# Espera a que el healthcheck del contenedor dé healthy.
health_gate() {
  local svc=$1 timeout=${2:-180} waited=0 id status=no-hay-contenedor
  while :; do
    id=$(compose ps -q "$svc" 2>/dev/null || true)
    if [ -n "$id" ]; then
      status=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo sin-healthcheck)
      if [ "$status" = healthy ]; then
        log "gate: $svc healthy"
        return 0
      fi
    fi
    if [ "$waited" -ge "$timeout" ]; then
      log "gate: $svc no quedó healthy en ${timeout}s (estado: $status)"
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}
