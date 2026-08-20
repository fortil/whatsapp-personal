import { Redis } from 'ioredis'

let redis: Redis | undefined

/** Conexión única a redis (rate limit + health). Lazy como la del postgres. */
export function getRedis(url = process.env.REDIS_URL): Redis {
  if (!redis) {
    if (!url) throw new Error('REDIS_URL no está definida. Copia .env.example a .env y llénala.')
    redis = new Redis(url)
  }
  return redis
}

/** Cierra la conexión: obligatorio en scripts y tests. */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => redis?.disconnect())
    redis = undefined
  }
}
