import { closeClient } from '@wp/db'
import { readEnv, missingStartupSecrets } from './env.js'
import { closeRedis } from './redis.js'
import { buildApp } from './app.js'

const env = readEnv()

const missing = missingStartupSecrets(env)
if (missing.length > 0) {
  // sin secretos no hay tokens firmables ni webhooks verificables: arrancar
  // sería fingir seguridad
  throw new Error(`Faltan variables obligatorias: ${missing.join(', ')}. Genera cada una con openssl rand -hex 32.`)
}

const app = await buildApp({ env })

try {
  await app.listen({ port: env.apiPort, host: '0.0.0.0' })
  console.log(`API escuchando en http://localhost:${env.apiPort}`)
} catch (err) {
  console.error('No se pudo escuchar:', err instanceof Error ? err.message : err)
  process.exit(1)
}

async function shutdown(signal: string) {
  console.log(`[${signal}] cerrando API`)
  await app.close()
  await closeRedis()
  await closeClient()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
