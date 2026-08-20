import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, asc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm'
import { contacts, conversations, type Db } from '@wp/db'
import { requireApproved } from '../auth/middleware.js'
import { hasActiveRun, startTaskRun } from '../services/tasks.js'
import type { RouteDeps } from './auth.js'

/**
 * Contactos: listado/búsqueda solo de canónicos (merged_into_contact_id IS
 * NULL), edición manual de nombre/cumpleaños y disparadores de sync/resumen/
 * export. Toda query filtra user_id: aislamiento sin RLS, igual que el resto
 * de la API. El encolado de jobs pasa por services/tasks.ts (startTaskRun),
 * que crea la fila de task_runs y la engancha con su bullmq_job_id: el
 * webhook (primera conexión del canal) usa el mismo helper.
 */

const PAGE_SIZE = 30

function publicContact(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    waJid: row.waJid,
    phoneE164: row.phoneE164,
    isLid: row.isLid,
    displayName: row.displayName,
    waName: row.waName,
    birthMonth: row.birthMonth,
    birthDay: row.birthDay,
    birthYear: row.birthYear,
    birthdaySource: row.birthdaySource,
  }
}

function parseIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** La conversación que representa al contacto: la de su propio jid; si no existe, la más reciente. */
async function primaryConversationId(
  db: Db,
  userId: string,
  contact: { id: string; waJid: string },
): Promise<string | null> {
  const own = (
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.contactId, contact.id),
          eq(conversations.waJid, contact.waJid),
        ),
      )
      .limit(1)
  )[0]
  if (own) return own.id
  const any = (
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.contactId, contact.id)))
      // nulls last: last_message_at puede ser null (conversación sin mensajes)
      // y en Postgres el desc plano pone los null primero; desempate por id
      // para que el orden sea estable entre páginas
      .orderBy(sql`${conversations.lastMessageAt} desc nulls last, ${conversations.id} desc`)
      .limit(1)
  )[0]
  return any?.id ?? null
}

export function registerContactRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, env } = deps
  const requireApprovedHook = requireApproved({ db, jwtSecret: env.jwtSecret })

  function unavailable(reply: FastifyReply) {
    return reply.code(503).send({ error: 'el worker no está disponible; inténtalo de nuevo' })
  }

  app.register(async (scope) => {
    scope.addHook('preHandler', requireApprovedHook)

    scope.post('/contacts/sync', async (request, reply) => {
      const userId = request.user!.id
      if (await hasActiveRun(db, userId, 'contacts_sync')) {
        return reply.code(409).send({ error: 'ya hay una sincronización de contactos en curso' })
      }
      const result = await startTaskRun(db, {
        userId,
        kind: 'contacts_sync',
        jobName: 'contacts_sync',
        jobData: { userId },
        producer: deps.taskQueue,
      })
      if ('error' in result) return unavailable(reply)
      return reply.send({ ok: true, taskRunId: result.id })
    })

    scope.get('/contacts', async (request, reply) => {
      const userId = request.user!.id
      const query = request.query as { query?: string; cursor?: string }
      const search = (query.query ?? '').trim()

      const filters = [eq(contacts.userId, userId), isNull(contacts.mergedIntoContactId)]
      if (search) {
        const like = `%${search}%`
        filters.push(or(ilike(contacts.displayName, like), ilike(contacts.waName, like), ilike(contacts.phoneE164, like))!)
      }
      if (query.cursor) {
        if (!/^[0-9a-f-]{36}$/i.test(query.cursor)) return reply.code(400).send({ error: 'cursor inválido' })
        filters.push(gt(contacts.id, query.cursor))
      }

      const rows = await db
        .select()
        .from(contacts)
        .where(and(...filters))
        .orderBy(asc(contacts.id))
        .limit(PAGE_SIZE + 1)

      const page = rows.slice(0, PAGE_SIZE)
      const next = rows.length > PAGE_SIZE ? page[PAGE_SIZE - 1] : undefined
      return reply.send({ items: page.map(publicContact), nextCursor: next ? next.id : null })
    })

    scope.patch('/contacts/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.user!.id
      const row = (await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.userId, userId))).limit(1))[0]
      if (!row) return reply.code(404).send({ error: 'contacto no encontrado' })

      const body = (request.body ?? {}) as Record<string, unknown>
      const updates: Record<string, unknown> = {}

      if (typeof body.displayName === 'string') {
        const trimmed = body.displayName.trim()
        updates.displayName = trimmed || null
      }

      const touchesBirthday = 'birthMonth' in body || 'birthDay' in body || 'birthYear' in body
      if (touchesBirthday) {
        if ('birthMonth' in body) {
          const month = parseIntOrNull(body.birthMonth)
          if (month !== null && (month < 1 || month > 12)) return reply.code(400).send({ error: 'mes de cumpleaños inválido' })
          updates.birthMonth = month
        }
        if ('birthDay' in body) {
          const day = parseIntOrNull(body.birthDay)
          if (day !== null && (day < 1 || day > 31)) return reply.code(400).send({ error: 'día de cumpleaños inválido' })
          updates.birthDay = day
        }
        if ('birthYear' in body) updates.birthYear = parseIntOrNull(body.birthYear)
        updates.birthdaySource = 'manual'
      }

      if (Object.keys(updates).length === 0) return reply.code(400).send({ error: 'nada para actualizar' })

      const [updated] = await db.update(contacts).set(updates).where(eq(contacts.id, id)).returning()
      return reply.send({ ok: true, contact: publicContact(updated!) })
    })

    scope.post('/contacts/:id/summarize', async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.user!.id
      const contact = (
        await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.userId, userId))).limit(1)
      )[0]
      if (!contact) return reply.code(404).send({ error: 'contacto no encontrado' })

      const conversationId = await primaryConversationId(db, userId, contact)
      if (!conversationId) return reply.code(400).send({ error: 'este contacto todavía no tiene conversación' })

      const result = await startTaskRun(db, {
        userId,
        kind: 'summarize',
        params: { conversationId },
        jobName: 'summarize',
        // force: el botón manual del panel no debe quedar bloqueado por el
        // umbral incremental de 20 mensajes nuevos
        jobData: { userId, conversationId, force: true },
        producer: deps.taskQueue,
      })
      if ('error' in result) return unavailable(reply)
      return reply.send({ ok: true, taskRunId: result.id })
    })

    scope.post('/contacts/export', async (request, reply) => {
      const userId = request.user!.id
      const body = (request.body ?? {}) as Record<string, unknown>
      const includeSummaries = body.includeSummaries === true

      const result = await startTaskRun(db, {
        userId,
        kind: 'contacts_export',
        params: { includeSummaries },
        jobName: 'contacts_export',
        jobData: { userId, includeSummaries },
        producer: deps.taskQueue,
      })
      if ('error' in result) return unavailable(reply)
      return reply.send({ ok: true, taskRunId: result.id })
    })
  })
}
