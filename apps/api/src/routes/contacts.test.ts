import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { closeClient, contacts, conversations, getDb, taskRuns, users, type Db } from '@wp/db'
import { closeRedis, getRedis } from '../redis.js'
import { buildApp } from '../app.js'
import { readEnv } from '../env.js'
import type { TaskProducer } from '../queues.js'
import { RUN, createDirectUser, inject, mail, phone, sessionCookie } from '../test-support.js'

/**
 * Contactos: listado/búsqueda solo de canónicos, edición de cumpleaños y
 * disparadores de sync/resumen/export. El criterio de aceptación de esta
 * fase es el aislamiento entre usuarios en /contacts (userB no ve ni edita
 * los contactos de userA).
 */

let app: FastifyInstance
let db: Db
let cookieA: string
let cookieB: string
let userIdA: string
let userIdB: string
let contactAId: string
let mergedAwayId: string
let conversationAId: string
const suiteUsers: string[] = []

function fakeProducer(): TaskProducer & { calls: Array<{ name: string; data: unknown }> } {
  const calls: Array<{ name: string; data: unknown }> = []
  return {
    calls,
    async add(name, data) {
      calls.push({ name, data })
      return `job-${calls.length}`
    },
  }
}

beforeAll(async () => {
  db = getDb()
  getRedis()
  const env = { ...readEnv(), jwtSecret: `test-contacts-${RUN}-secret` }
  app = await buildApp({ env, taskQueue: fakeProducer() })

  const userA = await createDirectUser(db, { email: mail('contactsA'), phone: phone(20) })
  const userB = await createDirectUser(db, { email: mail('contactsB'), phone: phone(21) })
  userIdA = userA.id
  userIdB = userB.id
  suiteUsers.push(userIdA, userIdB)
  cookieA = await sessionCookie(env.jwtSecret, userIdA)
  cookieB = await sessionCookie(env.jwtSecret, userIdB)

  const [contactA] = await db
    .insert(contacts)
    .values({ userId: userIdA, waJid: '573009990001@s.whatsapp.net', displayName: 'Contacto de A', phoneE164: '+573009990001' })
    .returning()
  contactAId = contactA!.id

  const [merged] = await db
    .insert(contacts)
    .values({ userId: userIdA, waJid: '573009990099@lid', displayName: 'Canónico fusionado', isLid: true })
    .returning()
  const [mergedAway] = await db
    .insert(contacts)
    .values({
      userId: userIdA,
      waJid: '573009990098@lid',
      displayName: 'Fusionado, no debe listarse',
      isLid: true,
      mergedIntoContactId: merged!.id,
    })
    .returning()
  mergedAwayId = mergedAway!.id

  const [conv] = await db
    .insert(conversations)
    .values({ userId: userIdA, contactId: contactAId, waJid: contactA!.waJid })
    .returning()
  conversationAId = conv!.id
})

afterAll(async () => {
  await db.delete(taskRuns).where(inArray(taskRuns.userId, suiteUsers)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUsers)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUsers)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUsers)).catch(() => {})
  await app.close()
  await closeRedis()
  await closeClient()
})

describe('GET /contacts', () => {
  it('sin sesión: 401', async () => {
    const res = await inject(app, 'GET', '/contacts')
    expect(res.status).toBe(401)
  })

  it('solo trae contactos canónicos del usuario dueño de la sesión', async () => {
    const res = await inject(app, 'GET', '/contacts', { cookie: cookieA })
    expect(res.status).toBe(200)
    const ids = res.body.items.map((c: { id: string }) => c.id)
    expect(ids).toContain(contactAId)
    expect(ids).not.toContain(mergedAwayId)
  })

  it('aislamiento: userB no ve los contactos de userA', async () => {
    const res = await inject(app, 'GET', '/contacts', { cookie: cookieB })
    expect(res.status).toBe(200)
    const ids = res.body.items.map((c: { id: string }) => c.id)
    expect(ids).not.toContain(contactAId)
  })

  it('query filtra por nombre', async () => {
    const res = await inject(app, 'GET', '/contacts?query=Contacto%20de%20A', { cookie: cookieA })
    expect(res.status).toBe(200)
    expect(res.body.items.some((c: { id: string }) => c.id === contactAId)).toBe(true)
  })
})

describe('PATCH /contacts/:id', () => {
  it('aislamiento: userB no puede editar un contacto de userA (404)', async () => {
    const res = await inject(app, 'PATCH', `/contacts/${contactAId}`, {
      cookie: cookieB,
      body: { displayName: 'Intento ajeno' },
    })
    expect(res.status).toBe(404)
  })

  it('actualiza cumpleaños y marca birthday_source manual', async () => {
    const res = await inject(app, 'PATCH', `/contacts/${contactAId}`, {
      cookie: cookieA,
      body: { birthMonth: 7, birthDay: 15, birthYear: 1990 },
    })
    expect(res.status).toBe(200)
    expect(res.body.contact.birthdaySource).toBe('manual')
    expect(res.body.contact.birthMonth).toBe(7)

    const row = (await db.select().from(contacts).where(eq(contacts.id, contactAId)).limit(1))[0]!
    expect(row.birthdaySource).toBe('manual')
  })

  it('mes de cumpleaños inválido: 400', async () => {
    const res = await inject(app, 'PATCH', `/contacts/${contactAId}`, {
      cookie: cookieA,
      body: { birthMonth: 13 },
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /contacts/sync', () => {
  it('encola la tarea y un segundo intento mientras está activa responde 409', async () => {
    const res = await inject(app, 'POST', '/contacts/sync', { cookie: cookieA, body: {} })
    expect(res.status).toBe(200)
    expect(res.body.taskRunId).toBeTruthy()

    const again = await inject(app, 'POST', '/contacts/sync', { cookie: cookieA, body: {} })
    expect(again.status).toBe(409)

    const task = (await db.select().from(taskRuns).where(eq(taskRuns.id, res.body.taskRunId)).limit(1))[0]!
    expect(task.kind).toBe('contacts_sync')
    expect(task.userId).toBe(userIdA)
  })
})

describe('POST /contacts/:id/summarize', () => {
  it('contacto sin conversación: 400', async () => {
    const [orphan] = await db
      .insert(contacts)
      .values({ userId: userIdA, waJid: '573009990002@s.whatsapp.net', displayName: 'Sin conversación' })
      .returning()
    const res = await inject(app, 'POST', `/contacts/${orphan!.id}/summarize`, { cookie: cookieA, body: {} })
    expect(res.status).toBe(400)
  })

  it('aislamiento: userB no puede pedir el resumen de un contacto de userA', async () => {
    const res = await inject(app, 'POST', `/contacts/${contactAId}/summarize`, { cookie: cookieB, body: {} })
    expect(res.status).toBe(404)
  })

  it('con conversación: encola el resumen con force y taskRunId', async () => {
    const res = await inject(app, 'POST', `/contacts/${contactAId}/summarize`, { cookie: cookieA, body: {} })
    expect(res.status).toBe(200)
    const task = (await db.select().from(taskRuns).where(eq(taskRuns.id, res.body.taskRunId)).limit(1))[0]!
    expect(task.kind).toBe('summarize')
    void conversationAId
  })
})

describe('POST /contacts/export', () => {
  it('encola contacts_export con params.includeSummaries', async () => {
    const res = await inject(app, 'POST', '/contacts/export', { cookie: cookieA, body: { includeSummaries: true } })
    expect(res.status).toBe(200)
    const task = (await db.select().from(taskRuns).where(eq(taskRuns.id, res.body.taskRunId)).limit(1))[0]!
    expect(task.kind).toBe('contacts_export')
    expect(task.params).toEqual({ includeSummaries: true })
  })
})
