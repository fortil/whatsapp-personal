import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { closeClient, contacts, conversations, getDb, messages, users, type Db } from '@wp/db'
import { sweepStuckTranscriptions } from './reaper.js'

/**
 * sweepStuckTranscriptions contra el postgres real, mismo patrón que
 * transcribe.test.ts: nada de esto arranca el worker (Redis, BullMQ, health
 * server), así que "pending colgado → reaper lo marca error" queda
 * reproducible por el revisor y no solo prosa del reporte.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`

let db: Db
let userId: string
let conversationId: string
let staleMsgId: string
let freshMsgId: string
let freshMsgId2: string
const suiteUserIds: string[] = []

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-reaper.${RUN}@mail.test`,
      phone: `+57301${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)

  const [contact] = await db
    .insert(contacts)
    .values({ userId, waJid: '573002223344@s.whatsapp.net', displayName: 'Prueba reaper' })
    .returning()
  const [conv] = await db
    .insert(conversations)
    .values({ userId, contactId: contact!.id, waJid: contact!.waJid, lastMessageAt: new Date() })
    .returning()
  conversationId = conv!.id

  const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000)
  const oneMinuteAgo = new Date(Date.now() - 60_000)

  const [stale] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-STALE-${RUN}`,
      direction: 'in',
      type: 'audio',
      transcriptStatus: 'pending',
      transcribeStartedAt: elevenMinutesAgo,
      sentAt: elevenMinutesAgo,
    })
    .returning()
  staleMsgId = stale!.id

  const [fresh] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-FRESH-${RUN}`,
      direction: 'in',
      type: 'audio',
      transcriptStatus: 'pending',
      transcribeStartedAt: oneMinuteAgo,
      sentAt: oneMinuteAgo,
    })
    .returning()
  freshMsgId = fresh!.id

  const [fresh2] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-FRESH2-${RUN}`,
      direction: 'in',
      type: 'audio',
      transcriptStatus: 'pending',
      transcribeStartedAt: oneMinuteAgo,
      sentAt: oneMinuteAgo,
    })
    .returning()
  freshMsgId2 = fresh2!.id
})

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.userId, suiteUserIds)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

describe('sweepStuckTranscriptions', () => {
  it('pending colgado hace 11 minutos (umbral 10 min): queda en error', async () => {
    const touched = await sweepStuckTranscriptions(db, 10 * 60_000)
    expect(touched).toBeGreaterThanOrEqual(1)
    const row = (await db.select().from(messages).where(eq(messages.id, staleMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('error')
  })

  it('pending reciente hace 1 minuto (umbral 10 min): sigue en pending', async () => {
    await sweepStuckTranscriptions(db, 10 * 60_000)
    const row = (await db.select().from(messages).where(eq(messages.id, freshMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('pending')
  })

  it('umbral explícito de 30s: un mensaje de hace 1 minuto también cae (fila propia, sin depender de las anteriores)', async () => {
    const touched = await sweepStuckTranscriptions(db, 30_000)
    expect(touched).toBeGreaterThanOrEqual(1)
    const row = (await db.select().from(messages).where(eq(messages.id, freshMsgId2)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('error')
  })
})
