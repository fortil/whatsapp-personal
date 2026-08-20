import type { Redis } from 'ioredis'

/**
 * Limitador fijo por ventana sobre redis: INCR + PEXPIRE en la primera.
 * Claves planas `rl:{bucket}:{id}` para poder inspeccionarlas con redis-cli.
 * Si redis está caído permite el paso y loguea: perder el limitador no debe
 * cerrar el login entero (los secrets siguen protegiendo las rutas).
 */
export async function checkRateLimit(
  redis: Redis,
  bucket: string,
  id: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const key = `rl:${bucket}:${id}`
  try {
    const count = await redis.incr(key)
    if (count === 1) await redis.pexpire(key, windowMs)
    return count <= limit
  } catch (err) {
    console.error('[ratelimit] redis no disponible, permitiendo:', err instanceof Error ? err.message : err)
    return true
  }
}

/**
 * IP del cliente detrás de Caddy. Con trustProxy el primer hop de
 * X-Forwarded-For es el cliente real; el resto son proxies que añadió cada
 * salto.
 */
export function clientIp(xForwardedFor: string | undefined, socketRemoteAddress?: string): string {
  if (xForwardedFor) {
    const first = xForwardedFor.split(',')[0]!.trim()
    if (first) return first
  }
  return socketRemoteAddress ?? 'desconocida'
}
