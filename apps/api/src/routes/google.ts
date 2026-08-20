import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { googleAccounts, type Db } from '@wp/db'
import { buildConsentUrl, decryptSecret, encryptSecret, exchangeCode, fetchProfileEmail, revokeToken } from '@wp/google'
import { GOOGLE_SCOPES } from '@wp/google'
import { signToken, verifyToken } from '../auth/jwt.js'
import { requireApproved } from '../auth/middleware.js'
import { hasActiveRun, startTaskRun } from '../services/tasks.js'
import type { RouteDeps } from './auth.js'

/**
 * Vinculación de Google: OAuth ida y vuelta para importar cumpleaños de
 * Contacts y crear eventos anuales en Calendar. El state del OAuth es un JWT
 * HS256 de 10 minutos con el userId (sin tabla): el callback puede llegar sin
 * cookie de sesión porque el navegador viene de redirigir Google, y la firma
 * del state es la que ata el code al usuario que pidió vincular.
 *
 * Sin GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI todo responde 503 salvo /google/
 * status, que reporta configured=false para que el panel muestre la sección
 * deshabilitada con el motivo en vez de una página rota.
 */

const STATE_TTL_SECONDS = 10 * 60

export function registerGoogleRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, env } = deps
  const requireApprovedHook = requireApproved({ db, jwtSecret: env.jwtSecret })

  const configured = () =>
    Boolean(env.googleClientId && env.googleClientSecret && env.googleRedirectUri && env.encryptionKey)

  function unavailable(reply: FastifyReply) {
    return reply.code(503).send({ error: 'Google no está configurado en este servidor' })
  }

  async function accountRow(userId: string) {
    return (await db.select().from(googleAccounts).where(eq(googleAccounts.userId, userId)).limit(1))[0]
  }

  // público y sin cookie: la autenticidad la da el state firmado
  app.get('/google/callback', async (request, reply) => {
    if (!configured()) return unavailable(reply)
    const query = request.query as { code?: string; state?: string; error?: string }

    const fail = (message: string) => reply.redirect(`${env.panelUrl}/google?error=${encodeURIComponent(message)}`)

    const payload = await verifyToken(env.jwtSecret, query.state)
    if (!payload || payload.scope !== 'gstate') return fail('el vínculo expiró; vuelve a intentar la vinculación')

    if (query.error || !query.code) {
      return fail(query.error === 'access_denied' ? 'no aceptaste los permisos de Google' : 'Google no devolvió el código de autorización')
    }

    const oauthConfig = {
      clientId: env.googleClientId,
      clientSecret: env.googleClientSecret,
      redirectUri: env.googleRedirectUri,
    }

    let tokens
    try {
      tokens = await exchangeCode(oauthConfig, query.code)
    } catch (err) {
      console.error('[google] exchange del code falló:', err instanceof Error ? err.message : err)
      return fail('no se pudo completar la vinculación con Google')
    }
    if (!tokens.refreshToken) {
      // con prompt=consent + access_type=offline no debería pasar; si pasa,
      // no hay nada persistible que refresque después
      return fail('Google no devolvió refresh token; inténtalo de nuevo')
    }

    let googleEmail: string
    try {
      googleEmail = await fetchProfileEmail(tokens.accessToken)
    } catch (err) {
      console.error('[google] people/me falló:', err instanceof Error ? err.message : err)
      return fail('no se pudo leer el correo de tu cuenta de Google')
    }

    await db
      .insert(googleAccounts)
      .values({
        userId: payload.sub,
        googleEmail,
        refreshTokenEnc: encryptSecret(env.encryptionKey, tokens.refreshToken),
        scopes: tokens.scope ?? GOOGLE_SCOPES.join(' '),
        // la vinculación nueva arranca sin sync token: el primer import es
        // completo, aunque re-vincular la misma cuenta dispare un 410 después
        peopleSyncToken: null,
      })
      .onConflictDoUpdate({
        target: googleAccounts.userId,
        set: {
          googleEmail,
          refreshTokenEnc: encryptSecret(env.encryptionKey, tokens.refreshToken),
          scopes: tokens.scope ?? GOOGLE_SCOPES.join(' '),
          peopleSyncToken: null,
          connectedAt: new Date(),
          revokedAt: null,
        },
      })

    return reply.redirect(`${env.panelUrl}/google`)
  })

  app.register(async (scope) => {
    scope.addHook('preHandler', requireApprovedHook)

    scope.get('/google/status', async (request) => {
      const row = await accountRow(request.user!.id)
      return {
        configured: configured(),
        connected: configured() && row !== undefined,
        googleEmail: row?.googleEmail ?? null,
        connectedAt: row?.connectedAt ? row.connectedAt.toISOString() : null,
      }
    })

    scope.get('/google/connect', async (request, reply) => {
      if (!configured()) return unavailable(reply)
      const state = await signToken(env.jwtSecret, { sub: request.user!.id, scope: 'gstate' }, STATE_TTL_SECONDS)
      const url = buildConsentUrl(
        {
          clientId: env.googleClientId,
          clientSecret: env.googleClientSecret,
          redirectUri: env.googleRedirectUri,
        },
        state,
      )
      return { url }
    })

    scope.post('/google/disconnect', async (request, reply) => {
      if (!configured()) return unavailable(reply)
      const row = await accountRow(request.user!.id)
      if (row) {
        // revoke best-effort: aunque Google no responda, la fila local se borra
        try {
          await revokeToken(decryptSecret(env.encryptionKey, row.refreshTokenEnc))
        } catch (err) {
          console.error('[google] no se pudo descifrar para revocar (se borra igual):', err instanceof Error ? err.message : err)
        }
        await db.delete(googleAccounts).where(eq(googleAccounts.userId, request.user!.id))
      }
      return { ok: true }
    })

    async function enqueueBirthdayRun(
      request: FastifyRequest,
      reply: FastifyReply,
      kind: 'birthday_import' | 'birthday_calendar_sync',
    ) {
      if (!configured()) return unavailable(reply)
      const userId = request.user!.id
      if (!(await accountRow(userId))) {
        return reply.code(400).send({ error: 'vincula tu cuenta de Google primero' })
      }
      if (await hasActiveRun(db, userId, kind)) {
        return reply.code(409).send({ error: 'ya hay una tarea de Google de ese tipo en curso' })
      }
      const result = await startTaskRun(db, {
        userId,
        kind,
        jobName: kind,
        jobData: { userId },
        producer: deps.taskQueue,
      })
      if ('error' in result) {
        return reply.code(503).send({ error: 'el worker no está disponible; inténtalo de nuevo' })
      }
      return reply.send({ ok: true, taskRunId: result.id })
    }

    scope.post('/google/birthdays/import', async (request, reply) => {
      return enqueueBirthdayRun(request, reply, 'birthday_import')
    })

    scope.post('/google/birthdays/create-events', async (request, reply) => {
      return enqueueBirthdayRun(request, reply, 'birthday_calendar_sync')
    })
  })
}
