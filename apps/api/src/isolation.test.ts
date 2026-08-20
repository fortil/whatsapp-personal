import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import {
  closeClient,
  contacts,
  conversations,
  getDb,
  googleAccounts,
  messages,
  taskRuns,
  trustedDevices,
  users,
  verificationCodes,
  waInstances,
  type Db,
} from '@wp/db'
import { encryptSecret } from '@wp/google'
import { closeRedis, getRedis } from './redis.js'
import { buildApp } from './app.js'
import { readEnv } from './env.js'
import { verifyToken } from './auth/jwt.js'
import type { TaskProducer } from './queues.js'
import {
  RUN,
  createDirectUser,
  fakeEvolution,
  inject,
  mail,
  phone,
  purgeTestUsers,
  sessionCookie,
  type FakeEvolution,
} from './test-support.js'

/**
 * Aislamiento por user_id sobre TODA la superficie autenticada, el test de más
 * valor de la fase de hardening: no hay RLS que frente un `where` olvidado,
 * esta suite es la red. Siembra dos usuarios (A con datos, B vacío) y recorre
 * inbox, contactos, tareas, canal, Google y dispositivos de confianza
 * comprobando que B no ve ni toca nada de A, y que A sí puede.
 */

const JWT_SECRET = `test-iso-${RUN}-secret`
const ENC_KEY = '4b'.repeat(32)

let app: FastifyInstance
let db: Db
let evolution: FakeEvolution
let cookieA: string
let cookieB: string
let userIdA: string
let userIdB: string

let convA: string
let textMsgA: string
let audioMsgA: string
let contactA: string
let exportTaskA: string
let deviceA: string
let exportFile: string
let exportDir: string
const queue: Array<{ name: string; data: unknown }> = []

const fakeProducer: TaskProducer = {
  async add(name, data) {
    queue.push({ name, data: JSON.parse(JSON.stringify(data)) })
    return `job-${queue.length}`
  },
}

beforeAll(async () => {
  db = getDb()
  getRedis()
  await purgeTestUsers(db)
  evolution = fakeEvolution()
  const env = {
    ...readEnv(),
    jwtSecret: JWT_SECRET,
    webhookSecret: `whsec-${RUN}`,
    evolutionApiUrl: 'http://evo.test',
    evolutionApiKey: 'k',
    publicApiUrl: 'http://api.test',
    panelUrl: 'https://panel.test',
    googleClientId: 'cid-test.apps.googleusercontent.com',
    googleClientSecret: 'GOCSPX-test',
    googleRedirectUri: 'https://api.test/google/callback',
    encryptionKey: ENC_KEY,
  }
  app = await buildApp({ env, evolution, taskQueue: fakeProducer })

  const userA = await createDirectUser(db, { email: mail('isoA'), phone: phone(80) })
  const userB = await createDirectUser(db, { email: mail('isoB'), phone: phone(81) })
  userIdA = userA.id
  userIdB = userB.id
  cookieA = await sessionCookie(JWT_SECRET, userIdA)
  cookieB = await sessionCookie(JWT_SECRET, userIdB)

  // ---- datos de A: contacto, conversación, mensajes, instancia, google, task
  const [contact] = await db
    .insert(contacts)
    .values({ userId: userIdA, waJid: '573008880001@s.whatsapp.net', displayName: 'Contacto de A', phoneE164: '+573008880001' })
    .returning()
  contactA = contact!.id

  const [conv] = await db
    .insert(conversations)
    .values({ userId: userIdA, contactId: contactA, waJid: contact!.waJid, lastMessageAt: new Date() })
    .returning()
  convA = conv!.id

  const [textMsg] = await db
    .insert(messages)
    .values({
      conversationId: convA,
      userId: userIdA,
      externalId: `ISO-TXT-${RUN}`,
      direction: 'in',
      type: 'text',
      body: 'secreto de A',
      sentAt: new Date(),
    })
    .returning()
  textMsgA = textMsg!.id

  const [audioMsg] = await db
    .insert(messages)
    .values({
      conversationId: convA,
      userId: userIdA,
      externalId: `ISO-AUD-${RUN}`,
      direction: 'in',
      type: 'audio',
      mediaMime: 'audio/ogg; codecs=opus',
      sentAt: new Date(),
    })
    .returning()
  audioMsgA = audioMsg!.id

  await db.insert(waInstances).values({
    userId: userIdA,
    instanceName: `u_${randomUUID().replaceAll('-', '')}`,
    state: 'connected',
  })

  await db.insert(googleAccounts).values({
    userId: userIdA,
    googleEmail: 'a@gmail.com',
    refreshTokenEnc: encryptSecret(ENC_KEY, '1//refresh-de-A'),
    scopes: 'calendar.events contacts.readonly userinfo.email',
  })

  exportDir = await mkdtemp(path.join(tmpdir(), `wp-iso-${RUN}-`))
  exportFile = path.join(exportDir, 'export-de-A.xlsx')
  await writeFile(exportFile, 'contenido del export de A')
  const [taskRun] = await db
    .insert(taskRuns)
    .values({
      userId: userIdA,
      kind: 'contacts_export',
      status: 'done',
      processed: 1,
      total: 1,
      filePath: exportFile,
      finishedAt: new Date(),
    })
    .returning()
  exportTaskA = taskRun!.id

  const [device] = await db
    .insert(trustedDevices)
    .values({
      userId: userIdA,
      tokenHash: `iso-${RUN}-hash`,
      userAgent: 'dispositivo de A',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    })
    .returning()
  deviceA = device!.id
})

afterAll(async () => {
  await rm(exportDir, { recursive: true, force: true }).catch(() => {})
  const both = [userIdA, userIdB].filter(Boolean)
  if (both.length) {
    await db.delete(messages).where(inArray(messages.userId, both)).catch(() => {})
    await db.delete(conversations).where(inArray(conversations.userId, both)).catch(() => {})
    await db.delete(contacts).where(inArray(contacts.userId, both)).catch(() => {})
    await db.delete(taskRuns).where(inArray(taskRuns.userId, both)).catch(() => {})
    await db.delete(waInstances).where(inArray(waInstances.userId, both)).catch(() => {})
    await db.delete(googleAccounts).where(inArray(googleAccounts.userId, both)).catch(() => {})
    await db.delete(trustedDevices).where(inArray(trustedDevices.userId, both)).catch(() => {})
    await db.delete(verificationCodes).where(inArray(verificationCodes.userId, both)).catch(() => {})
    await db.delete(users).where(inArray(users.id, both)).catch(() => {})
  }
  await app.close()
  await closeRedis()
  await closeClient()
})

describe('inbox: B no ve ni toca la conversación de A', () => {
  it('GET /inbox/conversations: A ve la suya, B no', async () => {
    const mine = await inject(app, 'GET', '/inbox/conversations', { cookie: cookieA })
    expect(mine.status).toBe(200)
    expect((mine.body.items as Array<{ id: string }>).some((c) => c.id === convA)).toBe(true)

    const theirs = await inject(app, 'GET', '/inbox/conversations', { cookie: cookieB })
    expect(theirs.status).toBe(200)
    expect((theirs.body.items as Array<{ id: string }>).some((c) => c.id === convA)).toBe(false)
  })

  it('GET mensajes de la conversación de A con sesión de B: 404', async () => {
    const res = await inject(app, 'GET', `/inbox/conversations/${convA}/messages`, { cookie: cookieB })
    expect(res.status).toBe(404)
  })

  it('POST mensaje en la conversación de A con sesión de B: 404 y Evolution jamás se entera', async () => {
    const callsBefore = evolution.calls.length
    const res = await inject(app, 'POST', `/inbox/conversations/${convA}/messages`, {
      cookie: cookieB,
      body: { text: 'mensaje intruso' },
    })
    expect(res.status).toBe(404)
    expect(evolution.calls.length).toBe(callsBefore)
  })

  it('POST read de B no marca los mensajes de A como leídos', async () => {
    const res = await inject(app, 'POST', `/inbox/conversations/${convA}/read`, { cookie: cookieB, body: {} })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(0)
    const row = (await db.select().from(messages).where(eq(messages.id, textMsgA)).limit(1))[0]!
    expect(row.readAt).toBeNull()
  })

  it('POST transcribe del audio de A con sesión de B: 404 y nada encolado', async () => {
    const before = queue.length
    const res = await inject(app, 'POST', `/inbox/messages/${audioMsgA}/transcribe`, { cookie: cookieB, body: {} })
    expect(res.status).toBe(404)
    expect(queue.length).toBe(before)
  })

  it('control: A sí transcribe su audio (queda pending y encolado)', async () => {
    const saved = process.env.LOCAL_ASR_BASE_URL
    process.env.LOCAL_ASR_BASE_URL = 'http://asr.test'
    try {
      const before = queue.length
      const res = await inject(app, 'POST', `/inbox/messages/${audioMsgA}/transcribe`, { cookie: cookieA, body: {} })
      expect(res.status).toBe(200)
      expect(queue.length).toBe(before + 1)
      expect(queue[queue.length - 1]!.name).toBe('transcribe')
    } finally {
      if (saved === undefined) delete process.env.LOCAL_ASR_BASE_URL
      else process.env.LOCAL_ASR_BASE_URL = saved
    }
  })
})

describe('contactos: B no ve ni edita los de A', () => {
  it('GET /contacts: B no recibe el contacto de A', async () => {
    const mine = await inject(app, 'GET', '/contacts', { cookie: cookieA })
    expect((mine.body.items as Array<{ id: string }>).some((c) => c.id === contactA)).toBe(true)
    const theirs = await inject(app, 'GET', '/contacts', { cookie: cookieB })
    expect(theirs.status).toBe(200)
    expect((theirs.body.items as Array<{ id: string }>).some((c) => c.id === contactA)).toBe(false)
  })

  it('PATCH del contacto de A con sesión de B: 404 y el nombre no cambia', async () => {
    const res = await inject(app, 'PATCH', `/contacts/${contactA}`, {
      cookie: cookieB,
      body: { displayName: 'Nombre robado' },
    })
    expect(res.status).toBe(404)
    const row = (await db.select().from(contacts).where(eq(contacts.id, contactA)).limit(1))[0]!
    expect(row.displayName).toBe('Contacto de A')
  })

  it('POST summarize del contacto de A con sesión de B: 404', async () => {
    const before = queue.length
    const res = await inject(app, 'POST', `/contacts/${contactA}/summarize`, { cookie: cookieB, body: {} })
    expect(res.status).toBe(404)
    expect(queue.length).toBe(before)
  })
})

describe('tareas: B no lista, ve ni descarga las de A', () => {
  it('GET /tasks: la tarea de A no aparece para B', async () => {
    const mine = await inject(app, 'GET', '/tasks', { cookie: cookieA })
    expect((mine.body.items as Array<{ id: string }>).some((t) => t.id === exportTaskA)).toBe(true)
    const theirs = await inject(app, 'GET', '/tasks', { cookie: cookieB })
    expect(theirs.status).toBe(200)
    expect((theirs.body.items as Array<{ id: string }>).some((t) => t.id === exportTaskA)).toBe(false)
  })

  it('GET /tasks/:id de A con sesión de B: 404', async () => {
    const res = await inject(app, 'GET', `/tasks/${exportTaskA}`, { cookie: cookieB })
    expect(res.status).toBe(404)
  })

  it('GET /tasks/:id/download: B recibe 404, A descarga el archivo', async () => {
    const stolen = await inject(app, 'GET', `/tasks/${exportTaskA}/download`, { cookie: cookieB })
    expect(stolen.status).toBe(404)
    const mine = await inject(app, 'GET', `/tasks/${exportTaskA}/download`, { cookie: cookieA })
    expect(mine.status).toBe(200)
  })
})

describe('canal: la instancia de WhatsApp vive por usuario', () => {
  it('sync de B reporta sin-instancia y no consulta la de A', async () => {
    const callsBefore = evolution.calls.length
    const res = await inject(app, 'POST', '/channel/sync', { cookie: cookieB, body: {} })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ estado: 'disconnected', qrEstado: 'sin-instancia' })
    expect(evolution.calls.length).toBe(callsBefore)
  })

  it('connect de B crea la instancia de B, no reutiliza la de A', async () => {
    const res = await inject(app, 'POST', '/channel/connect', { cookie: cookieB, body: {} })
    expect(res.status).toBe(200)
    const rows = await db.select().from(waInstances)
    const own = rows.find((r) => r.userId === userIdB)
    const other = rows.find((r) => r.userId === userIdA)
    expect(own).toBeDefined()
    expect(other).toBeDefined()
    expect(own!.id).not.toBe(other!.id)
    expect(own!.instanceName).not.toBe(other!.instanceName)
    // Evolution solo vio la instancia nueva de B
    expect(evolution.calls.some((c) => c.startsWith(`create:${own!.instanceName}`))).toBe(true)
    expect(evolution.calls.some((c) => c.startsWith(`create:${other!.instanceName}`))).toBe(false)
  })
})

describe('google: la vinculación vive por usuario', () => {
  it('status de B: no conectado aunque A lo esté', async () => {
    const mine = await inject(app, 'GET', '/google/status', { cookie: cookieA })
    expect(mine.body.connected).toBe(true)
    expect(mine.body.googleEmail).toBe('a@gmail.com')

    const theirs = await inject(app, 'GET', '/google/status', { cookie: cookieB })
    expect(theirs.status).toBe(200)
    expect(theirs.body.connected).toBe(false)
    expect(theirs.body.googleEmail).toBeNull()
  })

  it('connect de B firma el state con el userId de B', async () => {
    const res = await inject(app, 'GET', '/google/connect', { cookie: cookieB })
    expect(res.status).toBe(200)
    const state = new URL(res.body.url as string).searchParams.get('state')!
    const payload = await verifyToken(JWT_SECRET, state)
    expect(payload?.sub).toBe(userIdB)
  })

  it('birthdays/import de B: 400 porque B no tiene cuenta (no usa la de A)', async () => {
    const before = queue.length
    const res = await inject(app, 'POST', '/google/birthdays/import', { cookie: cookieB, body: {} })
    expect(res.status).toBe(400)
    expect(queue.length).toBe(before)
  })

  it('disconnect de B no borra la vinculación de A', async () => {
    const res = await inject(app, 'POST', '/google/disconnect', { cookie: cookieB, body: {} })
    expect(res.status).toBe(200)
    const row = (await db.select().from(googleAccounts).where(eq(googleAccounts.userId, userIdA)).limit(1))[0]
    expect(row).toBeDefined()
  })
})

describe('dispositivos de confianza: B no revoca los de A', () => {
  it('POST /auth/devices/:id/revoke del dispositivo de A con sesión de B: 404 y la fila vive', async () => {
    const res = await inject(app, 'POST', `/auth/devices/${deviceA}/revoke`, { cookie: cookieB, body: {} })
    expect(res.status).toBe(404)
    const row = (await db.select().from(trustedDevices).where(eq(trustedDevices.id, deviceA)).limit(1))[0]
    expect(row).toBeDefined()
  })
})
