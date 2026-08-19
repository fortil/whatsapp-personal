import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { type Db, waInstances, waStateEnum } from '@wp/db'
import type { ApiEnv } from '../env.js'
import { ingestMessage } from '../services/ingest.js'

/**
 * Webhook público de Evolution. Siempre responde 200, incluso al ignorar el
 * payload: un 4xx/5xx haría a Evolution reintentar en bucle y llenar la cola.
 * Lo único que puede producir 500 es una falla real de DB, donde el retry de
 * Evolution es justo lo que queremos.
 */

function secretMatches(received: string, expected: string): boolean {
  // comparación en tiempo constante sobre hashes del mismo largo
  const a = createHash('sha256').update(received).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function mapConnectionState(raw: unknown): (typeof waStateEnum)['enumValues'][number] | null {
  if (raw === 'open') return 'connected'
  if (raw === 'connecting') return 'connecting'
  if (raw === 'close') return 'disconnected'
  return null
}

export function registerWebhookRoutes(app: FastifyInstance, deps: { db: Db; env: ApiEnv }): void {
  const { db, env } = deps

  app.post('/webhooks/evolution/:instance', async (request, reply) => {
    const { instance } = request.params as { instance: string }
    const ignored = (reason: string) => {
      console.log(`[webhook] ${instance}: ${reason}`)
      return reply.send({ ignored: true })
    }

    const secret = request.headers['x-webhook-secret']
    if (typeof secret !== 'string' || !secretMatches(secret, env.webhookSecret)) {
      return ignored('secreto inválido, payload descartado')
    }

    const body = request.body as { event?: unknown; data?: unknown } | undefined
    if (!body || typeof body.event !== 'string') return ignored('payload sin event')

    const row = (
      await db.select().from(waInstances).where(eq(waInstances.instanceName, instance)).limit(1)
    )[0]
    if (!row) return ignored('instancia desconocida')

    if (body.event === 'connection.update') {
      const state = mapConnectionState(
        (body.data as { state?: unknown } | undefined)?.state,
      )
      if (!state) return ignored('connection.update sin estado reconocible')
      await db
        .update(waInstances)
        .set({ state, lastStateAt: new Date() })
        .where(eq(waInstances.id, row.id))
      return reply.send({ ok: true })
    }

    if (body.event === 'messages.upsert') {
      const result = await ingestMessage(db, row.userId, body.data)
      if (result.ignored) return reply.send({ ignored: true, reason: result.ignored })
      return reply.send({ ok: true, inserted: result.inserted })
    }

    return ignored(`event ${body.event} fuera de interés`)
  })
}
