import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import {
  closeClient,
  contacts,
  conversations,
  getDb,
  messages,
  users,
  verificationCodes,
  waInstances,
  type Db,
} from '@wp/db'
import { closeRedis, getRedis } from '../redis.js'
import { buildApp } from '../app.js'
import { readEnv } from '../env.js'
import type { TaskProducer } from '../queues.js'
import {
  RUN,
  createDirectUser,
  fakeEvolution,
  inject,
  mail,
  phone,
  purgeTestUsers,
  sessionCookie,
} from '../test-support.js'

/**
 * POST /inbox/messages/:id/transcribe: caché en done, 409 en pending, claim
 * atómico de none/error, 503 sin proveedor de ASR y 404 para el usuario
 * equivocado. El productor de jobs es una grabación: nada toca redis de más.
 */

let app: FastifyInstance
let db: Db
let cookie: string
let userId: string
let conversationId: string
/** Mensajes creados por la suite, para el cleanup. */
const suiteUsers: string[] = []
let audioMsg: typeof messages.$inferSelect
let textMsg: typeof messages.$inferSelect

const added: Array<{ name: string; data: { messageId?: string } }> = []
const fakeQueue: TaskProducer = {
  async add(name, data) {
    added.push({ name, data: JSON.parse(JSON.stringify(data)) as { messageId?: string } })
    return `job-${added.length}`
  },
}

beforeAll(async () => {
  db = getDb()
  getRedis()
  await purgeTestUsers(db)
  const env = {
    ...readEnv(),
    jwtSecret: `test-${RUN}-secret`,
    webhookSecret: `whsec-${RUN}`,
    evolutionApiUrl: 'http://evo.test',
    evolutionApiKey: 'k',
    publicApiUrl: 'http://api.test',
  }
  app = await buildApp({ env, evolution: fakeEvolution(), taskQueue: fakeQueue })

  const user = await createDirectUser(db, { email: mail('transcribe'), phone: phone(7) })
  userId = user.id
  suiteUsers.push(userId)
  cookie = await sessionCookie(env.jwtSecret, userId)

  const [contact] = await db
    .insert(contacts)
    .values({ userId, waJid: '573009990001@s.whatsapp.net', displayName: 'Prueba' })
    .returning()
  const [conv] = await db
    .insert(conversations)
    .values({ userId, contactId: contact!.id, waJid: contact!.waJid, lastMessageAt: new Date() })
    .returning()
  conversationId = conv!.id

  const [audio] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: 'FIX-ASR-AUDIO-1',
      direction: 'in',
      type: 'audio',
      mediaMime: 'audio/ogg; codecs=opus',
      sentAt: new Date(),
    })
    .returning()
  audioMsg = audio!
  const [text] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: 'FIX-ASR-TEXT-1',
      direction: 'in',
      type: 'text',
      body: 'hola',
      sentAt: new Date(),
    })
    .returning()
  textMsg = text!
})

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.userId, suiteUsers)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUsers)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUsers)).catch(() => {})
  await db.delete(waInstances).where(inArray(waInstances.userId, suiteUsers)).catch(() => {})
  await db.delete(verificationCodes).where(inArray(verificationCodes.userId, suiteUsers)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUsers)).catch(() => {})
  await app.close()
  await closeRedis()
  await closeClient()
})

describe('POST /inbox/messages/:id/transcribe', () => {
  it('sin sesión responde 401', async () => {
    const res = await inject(app, 'POST', `/inbox/messages/${audioMsg.id}/transcribe`, { body: {} })
    expect(res.status).toBe(401)
  })

  it('mensaje de otro usuario: 404 y sin encolar', async () => {
    const res = await inject(app, 'POST', '/inbox/messages/00000000-0000-0000-0000-000000000000/transcribe', {
      body: {},
      cookie,
    })
    expect(res.status).toBe(404)
    expect(added.length).toBe(0)
  })

  it('mensaje que no es audio: 400', async () => {
    const res = await inject(app, 'POST', `/inbox/messages/${textMsg.id}/transcribe`, { body: {}, cookie })
    expect(res.status).toBe(400)
  })

  it('sin proveedor de ASR configurado: 503 con mensaje que nombra las variables', async () => {
    const saved = {
      LOCAL_ASR_BASE_URL: process.env.LOCAL_ASR_BASE_URL,
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      LLM_PROVIDER: process.env.LLM_PROVIDER,
    }
    delete process.env.LOCAL_ASR_BASE_URL
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.OPENAI_API_KEY
    process.env.LLM_PROVIDER = 'local'
    try {
      const res = await inject(app, 'POST', `/inbox/messages/${audioMsg.id}/transcribe`, { body: {}, cookie })
      expect(res.status).toBe(503)
      expect(res.body.error).toContain('LOCAL_ASR_BASE_URL')
      // no encoló ni marcó pending
      expect(added.length).toBe(0)
      const row = (await db.select().from(messages).where(eq(messages.id, audioMsg.id)).limit(1))[0]
      expect(row!.transcriptStatus).toBe('none')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('audio nuevo: encola transcribe con el messageId y queda pending', async () => {
    const before = added.length
    const res = await inject(app, 'POST', `/inbox/messages/${audioMsg.id}/transcribe`, { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, transcriptStatus: 'pending' })
    expect(added.length).toBe(before + 1)
    expect(added[added.length - 1]!.name).toBe('transcribe')
    expect(added[added.length - 1]!.data.messageId).toBe(audioMsg.id)
  })

  it('segundo click con pending: 409 sin encolar otro job', async () => {
    const before = added.length
    const res = await inject(app, 'POST', `/inbox/messages/${audioMsg.id}/transcribe`, { body: {}, cookie })
    expect(res.status).toBe(409)
    expect(added.length).toBe(before)
  })

  it('con done devuelve la caché sin llamar a nadie', async () => {
    await db
      .update(messages)
      .set({ transcriptStatus: 'done', transcript: 'nota de voz transcrita', transcribedAt: new Date() })
      .where(eq(messages.id, audioMsg.id))
    const before = added.length
    const res = await inject(app, 'POST', `/inbox/messages/${audioMsg.id}/transcribe`, { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body.cached).toBe(true)
    expect(res.body.transcript).toBe('nota de voz transcrita')
    expect(added.length).toBe(before)
  })

  it('después de error se puede reintentar: encola de nuevo', async () => {
    await db
      .update(messages)
      .set({ transcriptStatus: 'error', transcript: null })
      .where(eq(messages.id, audioMsg.id))
    const before = added.length
    const res = await inject(app, 'POST', `/inbox/messages/${audioMsg.id}/transcribe`, { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body.transcriptStatus).toBe('pending')
    expect(added.length).toBe(before + 1)
  })

  it('GET messages expone transcript y transcript_status para el panel', async () => {
    const res = await inject(app, 'GET', `/inbox/conversations/${conversationId}/messages`, { cookie })
    expect(res.status).toBe(200)
    const audio = res.body.messages.find((m: { id: string }) => m.id === audioMsg.id)
    expect(audio.transcriptStatus).toBe('pending')
    expect(audio.transcript).toBeNull()
  })
})
