import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { waInstances, waStateEnum } from '@wp/db'
import { requireApproved } from '../auth/middleware.js'
import type { RouteDeps } from './auth.js'

type WaState = (typeof waStateEnum)['enumValues'][number]

/**
 * Rutas de vinculación del canal. La instancia se resuelve del userId del
 * token (no hay param en la URL): un usuario tiene una instancia y es la
 * suya. Respuesta con la máquina de estados del plan:
 * {estado, qrEstado: ok|solo-codigo|sin-qr|sin-instancia|no-aplica, ...}.
 */

export interface ChannelStatus {
  estado: WaState
  qrEstado: 'ok' | 'solo-codigo' | 'sin-qr' | 'sin-instancia' | 'no-aplica'
  qrBase64?: string | null
  code?: string | null
}

const NO_INSTANCE: ChannelStatus = { estado: 'disconnected', qrEstado: 'sin-instancia' }

export function registerChannelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, env, evolution } = deps
  const requireApprovedHook = requireApproved({ db, jwtSecret: env.jwtSecret })

  function unavailable(reply: FastifyReply) {
    return reply.code(503).send({ error: 'Evolution API no configurada en este servidor' })
  }

  const configured = () =>
    Boolean(evolution && env.evolutionApiUrl && env.evolutionApiKey && env.publicApiUrl)

  async function instanceRow(userId: string) {
    return (await db.select().from(waInstances).where(eq(waInstances.userId, userId)).limit(1))[0]
  }

  async function createInstanceRow(userId: string) {
    const inserted = await db
      .insert(waInstances)
      .values({
        userId,
        // u_ + uuid sin guiones, como lo espera el nombre de instancia
        instanceName: `u_${randomUUID().replaceAll('-', '')}`,
        state: 'connecting',
      })
      .onConflictDoNothing()
      .returning()
    if (inserted[0]) return inserted[0]
    return (await instanceRow(userId))!
  }

  async function persistState(id: string, state: WaState) {
    await db.update(waInstances).set({ state, lastStateAt: new Date() }).where(eq(waInstances.id, id))
  }

  async function fetchQr(instanceName: string): Promise<Pick<ChannelStatus, 'qrEstado' | 'qrBase64' | 'code'>> {
    try {
      const qr = await evolution!.connect(instanceName)
      if (qr.base64) return { qrEstado: 'ok', qrBase64: qr.base64, code: qr.code }
      if (qr.code) return { qrEstado: 'solo-codigo', qrBase64: null, code: qr.code }
      return { qrEstado: 'sin-qr', qrBase64: null, code: null }
    } catch (err) {
      console.error(
        `[channel] QR de ${instanceName} falló:`,
        err instanceof Error ? err.message : err,
      )
      return { qrEstado: 'sin-qr', qrBase64: null, code: null }
    }
  }

  /** Estado real según Evolution + estado persistido; fail-safe a disconnected. */
  async function syncState(row: typeof waInstances.$inferSelect): Promise<WaState> {
    const state: WaState = await evolution!.connectionState(row.instanceName)
    if (state !== row.state) await persistState(row.id, state)
    return state
  }

  async function setWebhook(instanceName: string) {
    await evolution!.setWebhook(instanceName, {
      url: `${env.publicApiUrl}/webhooks/evolution/${instanceName}`,
      secret: env.webhookSecret,
    })
  }

  /** Flujo común de conectar/reset: instancia en Evolution + webhook + QR. */
  async function linkAndRespond(
    reply: FastifyReply,
    row: typeof waInstances.$inferSelect,
  ) {
    try {
      await evolution!.createInstance(row.instanceName)
    } catch (err) {
      console.error('[channel] createInstance falló:', err instanceof Error ? err.message : err)
      return reply.code(502).send({ error: 'no se pudo crear la instancia en Evolution' })
    }
    try {
      await setWebhook(row.instanceName)
    } catch (err) {
      console.error('[channel] setWebhook falló:', err instanceof Error ? err.message : err)
      return reply.code(502).send({ error: 'no se pudo configurar el webhook en Evolution' })
    }
    const state = await syncState(row)
    if (state === 'connected') {
      return reply.send({ estado: state, qrEstado: 'no-aplica' } satisfies ChannelStatus)
    }
    return reply.send({ estado: state, ...(await fetchQr(row.instanceName)) } satisfies ChannelStatus)
  }

  app.register(async (channelScope) => {
    channelScope.addHook('preHandler', requireApprovedHook)

    channelScope.post('/channel/connect', async (request, reply) => {
      if (!configured()) return unavailable(reply)
      const userId = request.user!.id
      const existing = await instanceRow(userId)
      const row = existing ?? (await createInstanceRow(userId))
      return linkAndRespond(reply, row)
    })

    channelScope.post('/channel/sync', async (request, reply) => {
      if (!configured()) return unavailable(reply)
      const row = await instanceRow(request.user!.id)
      if (!row) return reply.send(NO_INSTANCE)
      // solo consulta: no crea nada en Evolution, pero re-fija el webhook por
      // si la instancia se desapuntó tras un reinicio
      try {
        await setWebhook(row.instanceName)
      } catch (err) {
        console.error('[channel] re-set webhook en sync falló (se continúa):', err instanceof Error ? err.message : err)
      }
      const state = await syncState(row)
      if (state === 'connected') {
        return reply.send({ estado: state, qrEstado: 'no-aplica' } satisfies ChannelStatus)
      }
      return reply.send({ estado: state, ...(await fetchQr(row.instanceName)) } satisfies ChannelStatus)
    })

    channelScope.post('/channel/reset', async (request, reply) => {
      if (!configured()) return unavailable(reply)
      const userId = request.user!.id
      const existing = await instanceRow(userId)
      const row = existing ?? (await createInstanceRow(userId))
      // logout best-effort: aunque falle, el delete es lo que limpia de verdad
      await evolution!.logout(row.instanceName)
      try {
        await evolution!.deleteInstance(row.instanceName)
      } catch (err) {
        console.error('[channel] deleteInstance falló:', err instanceof Error ? err.message : err)
        return reply.code(502).send({ error: 'no se pudo borrar la instancia en Evolution' })
      }
      await persistState(row.id, 'connecting')
      return linkAndRespond(reply, row)
    })

    channelScope.post('/channel/disconnect', async (request, reply) => {
      if (!configured()) return unavailable(reply)
      const row = await instanceRow(request.user!.id)
      if (!row) return reply.send(NO_INSTANCE)
      await evolution!.logout(row.instanceName)
      await persistState(row.id, 'logged_out')
      return reply.send({ estado: 'logged_out', qrEstado: 'no-aplica' } satisfies ChannelStatus)
    })
  })
}
