import type { FastifyInstance } from 'fastify'
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { contacts, conversations, messages, waInstances } from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import { requireApproved } from '../auth/middleware.js'
import { unreadCountExpr } from '../services/ingest.js'
import type { RouteDeps } from './auth.js'

/**
 * Inbox: lectura y respuesta de conversaciones. Toda query filtra user_id
 * (aislamiento aplicativo, sin RLS). El no-leído se deriva con subconsulta al
 * índice parcial; no hay contador que mantener.
 */

const PAGE_SIZE = 30

interface ConversationItem {
  id: string
  waJid: string
  name: string
  unread: number
  lastMessageAt: string | null
  lastMessage: { body: string | null; type: string; direction: string } | null
}

interface MessageItem {
  id: string
  direction: 'in' | 'out'
  type: string
  body: string | null
  mediaMime: string | null
  sentAt: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Cursor keyset: base64url de "iso-timestamp|id". */
function encodeCursor(date: Date | string, id: string): string {
  const iso = typeof date === 'string' ? date : date.toISOString()
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url')
}

function decodeCursor(raw: string): { date: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
    if (!iso || !id) return null
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return null
    return { date, id }
  } catch {
    return null
  }
}

function displayName(row: {
  waJid: string
  displayName: string | null
  waName: string | null
}): string {
  return row.displayName ?? row.waName ?? row.waJid.split('@')[0] ?? row.waJid
}

function messageItem(row: typeof messages.$inferSelect): MessageItem {
  return {
    id: row.id,
    direction: row.direction,
    type: row.type,
    body: row.body,
    mediaMime: row.mediaMime,
    sentAt: row.sentAt.toISOString(),
  }
}

export function registerInboxRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, env, evolution } = deps
  const requireApprovedHook = requireApproved({ db, jwtSecret: env.jwtSecret })

  app.register(async (inboxScope) => {
    inboxScope.addHook('preHandler', requireApprovedHook)

    inboxScope.get('/inbox/conversations', async (request, reply) => {
      const userId = request.user!.id
      const query = request.query as { cursor?: string }
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) return reply.code(400).send({ error: 'cursor inválido' })

      const rows = await db
        .select({
          id: conversations.id,
          waJid: conversations.waJid,
          lastMessageAt: conversations.lastMessageAt,
          displayName: contacts.displayName,
          waName: contacts.waName,
          unread: unreadCountExpr().as('unread'),
          // vista previa: el último mensaje, por el índice keyset
          lastBody: sql<string | null>`(
            select m.body from messages m
            where m.conversation_id = ${conversations.id}
            order by m.sent_at desc, m.id desc limit 1
          )`,
          lastType: sql<string | null>`(
            select m.type::text from messages m
            where m.conversation_id = ${conversations.id}
            order by m.sent_at desc, m.id desc limit 1
          )`,
          lastDirection: sql<string | null>`(
            select m.direction::text from messages m
            where m.conversation_id = ${conversations.id}
            order by m.sent_at desc, m.id desc limit 1
          )`,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(
          cursor
            ? and(
                eq(conversations.userId, userId),
                or(
                  lt(conversations.lastMessageAt, cursor.date),
                  and(eq(conversations.lastMessageAt, cursor.date), lt(conversations.id, cursor.id)),
                ),
              )
            : eq(conversations.userId, userId),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(PAGE_SIZE + 1)

      const page = rows.slice(0, PAGE_SIZE)

      const items: ConversationItem[] = page.map((r) => ({
        id: r.id,
        waJid: r.waJid,
        name: displayName(r),
        unread: Number(r.unread ?? 0),
        lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
        lastMessage:
          r.lastType === null && r.lastDirection === null
            ? null
            : { body: r.lastBody, type: r.lastType ?? 'other', direction: r.lastDirection ?? 'in' },
      }))

      const next = rows.length > PAGE_SIZE ? page[PAGE_SIZE - 1] : undefined
      return reply.send({
        items,
        nextCursor: next ? encodeCursor(next.lastMessageAt ?? new Date(0), next.id) : null,
      })
    })

    inboxScope.get('/inbox/conversations/:id/messages', async (request, reply) => {
      const userId = request.user!.id
      const { id } = request.params as { id: string }
      const query = request.query as { cursor?: string }
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) return reply.code(400).send({ error: 'cursor inválido' })

      const conv = (
        await db
          .select({
            id: conversations.id,
            waJid: conversations.waJid,
            displayName: contacts.displayName,
            waName: contacts.waName,
          })
          .from(conversations)
          .leftJoin(contacts, eq(contacts.id, conversations.contactId))
          .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
          .limit(1)
      )[0]
      if (!conv) return reply.code(404).send({ error: 'conversación no encontrada' })

      const rows = await db
        .select()
        .from(messages)
        .where(
          cursor
            ? and(
                eq(messages.conversationId, id),
                eq(messages.userId, userId),
                or(
                  lt(messages.sentAt, cursor.date),
                  and(eq(messages.sentAt, cursor.date), lt(messages.id, cursor.id)),
                ),
              )
            : and(eq(messages.conversationId, id), eq(messages.userId, userId)),
        )
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(PAGE_SIZE + 1)

      const page = rows.slice(0, PAGE_SIZE)
      const next = rows.length > PAGE_SIZE ? page[PAGE_SIZE - 1] : undefined
      return reply.send({
        conversation: { id: conv.id, waJid: conv.waJid, name: displayName(conv) },
        messages: page.map(messageItem),
        nextCursor: next ? encodeCursor(next.sentAt, next.id) : null,
      })
    })

    inboxScope.post('/inbox/conversations/:id/messages', async (request, reply) => {
      const userId = request.user!.id
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown> | undefined
      const text = str(body?.text)
      if (!text) return reply.code(400).send({ error: 'el mensaje no puede estar vacío' })

      const conv = (
        await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
          .limit(1)
      )[0]
      if (!conv) return reply.code(404).send({ error: 'conversación no encontrada' })

      const instance = (
        await db.select().from(waInstances).where(eq(waInstances.userId, userId)).limit(1)
      )[0]
      if (!instance) {
        return reply.code(409).send({ error: 'vincula tu WhatsApp antes de responder' })
      }
      if (!evolution || !env.evolutionApiUrl || !env.evolutionApiKey) {
        return reply.code(503).send({ error: 'Evolution API no configurada en este servidor' })
      }

      let sent: Awaited<ReturnType<EvolutionClient['sendText']>>
      try {
        // presencia "escribiendo" antes de cada envío: mitigación de baneo
        try {
          await evolution.sendPresence(instance.instanceName, { number: conv.waJid, delayMs: 1500 })
        } catch (err) {
          console.error('[inbox] sendPresence falló (se envía igual):', err instanceof Error ? err.message : err)
        }
        sent = await evolution.sendText(instance.instanceName, { number: conv.waJid, text })
      } catch (err) {
        console.error('[inbox] sendText falló:', err instanceof Error ? err.message : err)
        return reply.code(502).send({ error: 'no se pudo enviar el mensaje por WhatsApp' })
      }

      const sentAt = new Date()
      // el webhook puede haber ganado la carrera con el mismo key.id: el
      // ON CONFLICT DO NOTHING lo vuelve inocuo
      const inserted = await db
        .insert(messages)
        .values({
          conversationId: conv.id,
          userId,
          externalId: sent.messageId,
          direction: 'out',
          type: 'text',
          body: text,
          sentAt,
        })
        .onConflictDoNothing()
        .returning()

      if (inserted[0]) {
        const next =
          conv.lastMessageAt && conv.lastMessageAt > sentAt ? conv.lastMessageAt : sentAt
        await db
          .update(conversations)
          .set({ lastMessageAt: next })
          .where(eq(conversations.id, conv.id))
        return reply.send({ ok: true, message: messageItem(inserted[0]) })
      }

      // perdió la carrera: devolver la fila que ya está
      const existing = sent.messageId
        ? (
            await db
              .select()
              .from(messages)
              .where(
                and(
                  eq(messages.conversationId, conv.id),
                  eq(messages.userId, userId),
                  eq(messages.externalId, sent.messageId),
                ),
              )
              .limit(1)
          )[0]
        : undefined
      if (!existing) return reply.code(500).send({ error: 'el envío no quedó registrado' })
      return reply.send({ ok: true, message: messageItem(existing), raced: true })
    })

    inboxScope.post('/inbox/conversations/:id/read', async (request, reply) => {
      const userId = request.user!.id
      const { id } = request.params as { id: string }
      const updated = await db
        .update(messages)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(messages.conversationId, id),
            eq(messages.userId, userId),
            eq(messages.direction, 'in'),
            isNull(messages.readAt),
          ),
        )
        .returning({ id: messages.id })
      return reply.send({ ok: true, updated: updated.length })
    })
  })
}
