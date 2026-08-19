import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, like } from 'drizzle-orm'
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
import {
  RUN,
  createDirectUser,
  fakeEvolution,
  inject,
  mail,
  phone,
  sessionCookie,
  type FakeEvolution,
} from '../test-support.js'
import {
  audioIn,
  connectionEvent,
  editedText,
  fromMeText,
  groupText,
  lidNoPhone,
  lidWithPn,
  reaction,
  textIn,
  upsertEvent,
} from './evolution.js'

/**
 * Suite de fixtures de ingest + webhook handler: cada payload pasa por
 * POST /webhooks/evolution/:instance como en producción. Los payloads son
 * sintéticos con la forma de Baileys; la instancia real no existe en este run.
 */

const WEBHOOK_SECRET = `whsec-${RUN}`

let app: FastifyInstance
let db: Db
let evo: FakeEvolution
let instance: string
/** Usuarios creados por esta suite, para el cleanup del afterAll. */
const suiteUsers: string[] = []

/** Sesión del usuario principal de la suite. */
let mainUser: { id: string; email: string }
let mainCookie: string

async function deliver(payload: unknown, opts: { secret?: string; instance?: string } = {}) {
  return inject(app, 'POST', `/webhooks/evolution/${opts.instance ?? instance}`, {
    body: payload,
    headers: { 'x-webhook-secret': opts.secret ?? WEBHOOK_SECRET },
  })
}

function messagesBy(userId: string, externalId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.externalId, externalId)))
}

async function inboxList(cookie: string) {
  const res = await inject(app, 'GET', '/inbox/conversations', { cookie })
  expect(res.status).toBe(200)
  return res.body as {
    items: Array<{ id: string; waJid: string; name: string; unread: number; lastMessageAt: string | null; lastMessage: { body: string | null } | null }>
    nextCursor: string | null
  }
}

beforeAll(async () => {
  db = getDb()
  getRedis()
  evo = fakeEvolution()
  const env = {
    ...readEnv(),
    jwtSecret: `test-${RUN}-secret`,
    webhookSecret: WEBHOOK_SECRET,
    evolutionApiUrl: 'http://evo.test',
    evolutionApiKey: 'k',
    publicApiUrl: 'http://api.test',
  }
  app = await buildApp({ env, evolution: evo })

  mainUser = await createDirectUser(db, { email: mail('ingest'), phone: phone(1) })
  suiteUsers.push(mainUser.id)
  mainCookie = await sessionCookie(env.jwtSecret, mainUser.id)
  const [row] = await db
    .insert(waInstances)
    .values({ userId: mainUser.id, instanceName: `u_test${RUN}`, state: 'connecting' })
    .returning()
  instance = row!.instanceName
})

afterAll(async () => {
  // solo los usuarios de esta suite: otro archivo de test puede estar
  // compartiendo la DB con usuarios propios
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

describe('webhook: compuertas', () => {
  it('secreto inválido: 200 con ignored y ninguna fila escrita', async () => {
    const res = await deliver(upsertEvent(instance, textIn), { secret: 'otro-secreto' })
    expect(res.status).toBe(200)
    expect(res.body.ignored).toBe(true)
    expect((await messagesBy(mainUser.id, 'FIX-TEXT-1')).length).toBe(0)
  })

  it('instancia desconocida: 200 con ignored', async () => {
    const res = await deliver(upsertEvent('u_inexistente', textIn), { instance: 'u_inexistente' })
    expect(res.status).toBe(200)
    expect(res.body.ignored).toBe(true)
  })

  it('connection.update cambia el estado de la instancia', async () => {
    const res = await deliver(connectionEvent(instance, 'open'))
    expect(res.status).toBe(200)
    const byName = async () =>
      (await db.select().from(waInstances).where(eq(waInstances.instanceName, instance)))[0]!
    expect((await byName()).state).toBe('connected')
    await deliver(connectionEvent(instance, 'close'))
    expect((await byName()).state).toBe('disconnected')
  })
})

describe('ingest: fixtures de messages.upsert', () => {
  it('texto entrante crea contacto, conversación y mensaje con no-leído 1', async () => {
    const res = await deliver(upsertEvent(instance, textIn))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, inserted: true })

    const [msg] = await messagesBy(mainUser.id, 'FIX-TEXT-1')
    expect(msg).toBeDefined()
    expect(msg!.direction).toBe('in')
    expect(msg!.type).toBe('text')
    expect(msg!.body).toBe('hola, ¿me pasas la dirección?')
    expect(msg!.sentAt.getTime()).toBe(1787000000 * 1000)
    expect(msg!.readAt).toBeNull()

    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, mainUser.id), eq(contacts.waJid, '573001112233@s.whatsapp.net')))
    expect(contact).toBeDefined()
    expect(contact!.phoneE164).toBe('+573001112233')
    expect(contact!.isLid).toBe(false)
    expect(contact!.waName).toBe('María')

    const list = await inboxList(mainCookie)
    expect(list.items.length).toBe(1)
    expect(list.items[0]!.name).toBe('María')
    expect(list.items[0]!.unread).toBe(1)
    expect(list.items[0]!.lastMessage?.body).toContain('dirección')
  })

  it('retry duplicado del mismo webhook: ni fila nueva ni no-leído extra', async () => {
    const res = await deliver(upsertEvent(instance, textIn))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, inserted: false })

    expect((await messagesBy(mainUser.id, 'FIX-TEXT-1')).length).toBe(1)
    const list = await inboxList(mainCookie)
    expect(list.items[0]!.unread).toBe(1)
  })

  it('audio entrante queda como type audio con su mimetype', async () => {
    const res = await deliver(upsertEvent(instance, audioIn))
    expect(res.body).toEqual({ ok: true, inserted: true })
    const [msg] = await messagesBy(mainUser.id, 'FIX-AUDIO-1')
    expect(msg!.type).toBe('audio')
    expect(msg!.mediaMime).toBe('audio/ogg; codecs=opus')
    expect(msg!.body).toBeNull()
  })

  it('fromMe se persiste como out en la misma conversación y no suma no-leído', async () => {
    const res = await deliver(upsertEvent(instance, fromMeText))
    expect(res.body).toEqual({ ok: true, inserted: true })
    const [msg] = await messagesBy(mainUser.id, 'FIX-OUT-1')
    expect(msg!.direction).toBe('out')
    expect(msg!.body).toBe('claro, te la envío en un rato')

    const convs = await db.select().from(conversations).where(eq(conversations.userId, mainUser.id))
    expect(convs.length).toBe(1)
    const list = await inboxList(mainCookie)
    expect(list.items.length).toBe(1)
    // dos entrantes sin leer: el texto y el audio; el out no cuenta
    expect(list.items[0]!.unread).toBe(2)
  })

  it('grupo, edición y reacción se ignoran con 200 y no escriben nada', async () => {
    for (const [payload, id] of [
      [groupText, 'FIX-GROUP-1'],
      [editedText, 'FIX-EDIT-1'],
      [reaction, 'FIX-REACT-1'],
    ] as const) {
      const res = await deliver(upsertEvent(instance, payload))
      expect(res.status).toBe(200)
      expect(res.body.ignored).toBe(true)
      expect((await messagesBy(mainUser.id, id)).length).toBe(0)
    }
    // el grupo tampoco creó contacto ni conversación
    const groups = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, mainUser.id), like(conversations.waJid, '%@g.us')))
    expect(groups.length).toBe(0)
  })

  it('LID con senderPn se fusiona al contacto canónico del teléfono', async () => {
    // primero el mensaje por el jid de teléfono: crea el canónico
    const canonicalMsg = {
      ...textIn,
      key: { ...textIn.key, remoteJid: '573004445566@s.whatsapp.net', id: 'FIX-CANON-1' },
      pushName: 'Carlos',
    }
    await deliver(upsertEvent(instance, canonicalMsg))

    const res = await deliver(upsertEvent(instance, lidWithPn))
    expect(res.body).toEqual({ ok: true, inserted: true })

    const [canonical] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, mainUser.id), eq(contacts.waJid, '573004445566@s.whatsapp.net')))
    expect(canonical).toBeDefined()

    const [lidRow] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, mainUser.id), eq(contacts.waJid, '987654321012345@lid')))
    expect(lidRow).toBeDefined()
    expect(lidRow!.isLid).toBe(true)
    expect(lidRow!.mergedIntoContactId).toBe(canonical!.id)

    // la conversación del LID apunta al canónico
    const [lidConv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, mainUser.id), eq(conversations.waJid, '987654321012345@lid')))
    expect(lidConv!.contactId).toBe(canonical!.id)

    // y en la lista la conversación LID muestra el nombre del canónico
    const list = await inboxList(mainCookie)
    const lidItem = list.items.find((i) => i.id === lidConv!.id)
    expect(lidItem!.name).toBe('Carlos')
  })

  it('LID sin teléfono queda standalone con el payload en raw', async () => {
    const res = await deliver(upsertEvent(instance, lidNoPhone))
    expect(res.body).toEqual({ ok: true, inserted: true })

    const [lidRow] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, mainUser.id), eq(contacts.waJid, '555444333222111@lid')))
    expect(lidRow).toBeDefined()
    expect(lidRow!.isLid).toBe(true)
    expect(lidRow!.phoneE164).toBeNull()
    expect(lidRow!.mergedIntoContactId).toBeNull()

    const [msg] = await messagesBy(mainUser.id, 'FIX-LID-NOPHONE-1')
    const raw = msg!.raw as { key?: { remoteJid?: string } }
    expect(raw.key?.remoteJid).toBe('555444333222111@lid')
  })

  it('marcar leído lleva el no-leído a 0 y es idempotente', async () => {
    const list = await inboxList(mainCookie)
    const conv = list.items.find((i) => i.unread > 0)!
    const first = await inject(app, 'POST', `/inbox/conversations/${conv.id}/read`, { cookie: mainCookie })
    expect(first.status).toBe(200)
    expect(first.body.updated).toBeGreaterThanOrEqual(1)

    const after = await inboxList(mainCookie)
    expect(after.items.find((i) => i.id === conv.id)!.unread).toBe(0)

    const second = await inject(app, 'POST', `/inbox/conversations/${conv.id}/read`, { cookie: mainCookie })
    expect(second.body.updated).toBe(0)
  })
})

describe('inbox: respuesta y carrera webhook', () => {
  it('responder inserta el out y el webhook con el mismo key.id no duplica ni da 500', async () => {
    // la conversación de María, que ya existe por los fixtures anteriores
    const list = await inboxList(mainCookie)
    const conv = list.items.find((i) => i.waJid === '573001112233@s.whatsapp.net')!

    evo.nextMessageId = 'RACE-1'
    const reply = await inject(app, 'POST', `/inbox/conversations/${conv.id}/messages`, {
      body: { text: 'va la dirección' },
      cookie: mainCookie,
    })
    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    expect(reply.body.message.body).toBe('va la dirección')
    // presencia antes del envío: mitigación de baneo
    expect(evo.calls.filter((c) => c === 'presence').length).toBeGreaterThanOrEqual(1)

    // el webhook llega después con el mismo key.id: ON CONFLICT DO NOTHING
    const echoed = {
      ...fromMeText,
      key: { ...fromMeText.key, remoteJid: '573001112233@s.whatsapp.net', id: 'RACE-1' },
      message: { extendedTextMessage: { text: 'va la dirección' } },
    }
    const web = await deliver(upsertEvent(instance, echoed))
    expect(web.status).toBe(200)
    expect(web.body).toEqual({ ok: true, inserted: false })
    expect((await messagesBy(mainUser.id, 'RACE-1')).length).toBe(1)

    // y la conversación sigue respondiendo normal
    evo.nextMessageId = 'OUT-NEXT'
    const second = await inject(app, 'POST', `/inbox/conversations/${conv.id}/messages`, {
      body: { text: 'segundo mensaje' },
      cookie: mainCookie,
    })
    expect(second.status).toBe(200)
    expect((await messagesBy(mainUser.id, 'OUT-NEXT')).length).toBe(1)
  })

  it('respuesta vacía se rechaza y Evolution caído devuelve 502 sin insertar', async () => {
    const list = await inboxList(mainCookie)
    const conv = list.items.find((i) => i.waJid === '573001112233@s.whatsapp.net')!
    const empty = await inject(app, 'POST', `/inbox/conversations/${conv.id}/messages`, {
      body: { text: '   ' },
      cookie: mainCookie,
    })
    expect(empty.status).toBe(400)

    evo.failText = true
    const fail = await inject(app, 'POST', `/inbox/conversations/${conv.id}/messages`, {
      body: { text: 'no saldrá' },
      cookie: mainCookie,
    })
    expect(fail.status).toBe(502)
    expect((await messagesBy(mainUser.id, 'OUT-NEXT')).length).toBe(1)
    evo.failText = false
  })

  it('otro usuario no ve ni responde conversaciones ajenas', async () => {
    const other = await createDirectUser(db, { email: mail('otro'), phone: phone(2) })
    suiteUsers.push(other.id)
    const otherCookie = await sessionCookie(`test-${RUN}-secret`, other.id)
    const list = await inboxList(mainCookie)
    const conv = list.items[0]!

    const read = await inject(app, 'GET', `/inbox/conversations/${conv.id}/messages`, { cookie: otherCookie })
    expect(read.status).toBe(404)

    const send = await inject(app, 'POST', `/inbox/conversations/${conv.id}/messages`, {
      body: { text: 'hola' },
      cookie: otherCookie,
    })
    expect(send.status).toBe(404)

    const foreign = await inboxList(otherCookie)
    expect(foreign.items.length).toBe(0)
  })
})

describe('paginación keyset', () => {
  // PAGE_SIZE de routes/inbox.ts. Con menos filas que la página el cursor
  // nunca aparece, así que cada caso siembra más filas que la página y usa
  // un usuario propio: los conteos no dependen del resto de la suite.
  const PAGE = 30
  const BASE = 1787100000_000

  it('mensajes: hay segunda página, no repite ids y la última termina', async () => {
    const user = await createDirectUser(db, { email: mail('pagina'), phone: phone(3) })
    suiteUsers.push(user.id)
    const cookie = await sessionCookie(`test-${RUN}-secret`, user.id)

    const [conv] = await db
      .insert(conversations)
      .values({ userId: user.id, waJid: '573009990001@s.whatsapp.net', lastMessageAt: new Date(BASE) })
      .returning()
    await db.insert(messages).values(
      Array.from({ length: PAGE + 5 }, (_, i) => ({
        conversationId: conv!.id,
        userId: user.id,
        externalId: `PAGE-MSG-${i}`,
        direction: 'in' as const,
        type: 'text' as const,
        body: `mensaje ${i}`,
        sentAt: new Date(BASE + i * 1000),
      })),
    )

    const first = await inject(app, 'GET', `/inbox/conversations/${conv!.id}/messages`, { cookie })
    expect(first.status).toBe(200)
    expect(first.body.messages.length).toBe(PAGE)
    expect(first.body.nextCursor).toBeTruthy()

    const second = await inject(
      app,
      'GET',
      `/inbox/conversations/${conv!.id}/messages?cursor=${encodeURIComponent(first.body.nextCursor)}`,
      { cookie },
    )
    expect(second.status).toBe(200)
    expect(second.body.messages.length).toBe(5)
    expect(second.body.nextCursor).toBeNull()

    const ids1 = new Set((first.body.messages as Array<{ id: string }>).map((m) => m.id))
    for (const m of second.body.messages) expect(ids1.has(m.id)).toBe(false)
  })

  it('conversaciones: hay segunda página y no repite conversaciones', async () => {
    const user = await createDirectUser(db, { email: mail('pagina2'), phone: phone(4) })
    suiteUsers.push(user.id)
    const cookie = await sessionCookie(`test-${RUN}-secret`, user.id)

    await db.insert(conversations).values(
      Array.from({ length: PAGE + 2 }, (_, i) => ({
        userId: user.id,
        waJid: `5730099901${String(i).padStart(2, '0')}@s.whatsapp.net`,
        lastMessageAt: new Date(BASE + i * 1000),
      })),
    )

    const first = await inject(app, 'GET', '/inbox/conversations', { cookie })
    expect(first.status).toBe(200)
    expect(first.body.items.length).toBe(PAGE)
    expect(first.body.nextCursor).toBeTruthy()

    const second = await inject(
      app,
      'GET',
      `/inbox/conversations?cursor=${encodeURIComponent(first.body.nextCursor)}`,
      { cookie },
    )
    expect(second.status).toBe(200)
    expect(second.body.items.length).toBe(2)
    expect(second.body.nextCursor).toBeNull()

    const ids1 = new Set((first.body.items as Array<{ id: string }>).map((c) => c.id))
    for (const c of second.body.items) expect(ids1.has(c.id)).toBe(false)
  })
})
