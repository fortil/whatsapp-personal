import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { sql } from 'drizzle-orm'
import { closeClient, type Db, getDb } from '@wp/db'
import { createMailer, type Mailer } from '@wp/mailer'
import type { Redis } from 'ioredis'
import { readEnv, type ApiEnv } from './env.js'
import { getRedis } from './redis.js'
import { createSmsService, type SmsOtpService } from './services/sms.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes, type RouteDeps } from './routes/auth.js'

export interface BuildAppOptions {
  env?: ApiEnv
  mailer?: Mailer
  sms?: SmsOtpService
  redis?: Redis
}

/**
 * API ensamblada sin escuchar: los tests la usan con app.inject(). CORS queda
 * deshabilitado a propósito (el navegador jamás la llama; todo pasa por el
 * panel server-side) y las mutaciones exigen content-type application/json
 * para que un form-post cross-site no pase.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? readEnv()
  const db: Db = getDb()
  const redis = opts.redis ?? getRedis(env.redisUrl || undefined)
  const mailer =
    opts.mailer ?? createMailer({ driver: env.mailerDriver, from: env.mailFrom, apiKey: env.resendApiKey })
  const sms =
    opts.sms ??
    createSmsService({
      driver: env.smsDriver,
      accountSid: env.twilioAccountSid,
      authToken: env.twilioAuthToken,
      verifyServiceSid: env.twilioVerifyServiceSid,
    })

  const deps: RouteDeps = { db, redis, mailer, sms, env }
  const app = Fastify({ trustProxy: true })

  await app.register(cookie)

  // mutaciones con cuerpo solo con content-type application/json: un
  // form-post cross-site (que siempre manda body) queda afuera
  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
    const contentLength = request.headers['content-length']
    if (contentLength === undefined || contentLength === '0') return
    const contentType = request.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return reply.code(415).send({ error: 'content-type debe ser application/json' })
    }
  })

  app.get('/health', async (_request, reply) => {
    let dbOk = false
    let redisOk = false
    try {
      await db.execute(sql`select 1`)
      dbOk = true
    } catch {
      dbOk = false
    }
    try {
      redisOk = (await redis.ping()) === 'PONG'
    } catch {
      redisOk = false
    }
    if (!dbOk || !redisOk) return reply.code(503).send({ status: 'degradado', db: dbOk, redis: redisOk })
    return reply.send({ status: 'ok', db: true, redis: true })
  })

  registerAuthRoutes(app, deps)
  registerAdminRoutes(app, deps)

  // errores como {error: mensaje}, sin stack al cliente
  app.setErrorHandler((err: FastifyError, _request, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    if (status >= 500) console.error('[api] error no manejado:', err)
    reply.code(status).send({ error: err.message })
  })

  return app
}
