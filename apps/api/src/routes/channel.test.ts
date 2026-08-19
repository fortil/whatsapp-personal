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
import { createEvolutionClient } from '@wp/channels'
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

/**
 * Máquina de estados de /channel/*: connect, sync, reset y disconnect contra
 * un Evolution grabado, más el 503 cuando falta la configuración.
 */

let app: FastifyInstance
let app503: FastifyInstance
let db: Db
let evo: FakeEvolution
let cookie: string
let userId: string
/** Usuarios creados por esta suite, para el cleanup del afterAll. */
const suiteUsers: string[] = []

beforeAll(async () => {
  db = getDb()
  getRedis()
  evo = fakeEvolution()
  const env = {
    ...readEnv(),
    jwtSecret: `test-${RUN}-secret`,
    webhookSecret: `whsec-${RUN}`,
    evolutionApiUrl: 'http://evo.test',
    evolutionApiKey: 'k',
    publicApiUrl: 'http://api.test',
  }
  app = await buildApp({ env, evolution: evo })
  const noChannelEnv = { ...env, evolutionApiUrl: '', evolutionApiKey: '', publicApiUrl: '' }
  app503 = await buildApp({ env: noChannelEnv })

  const user = await createDirectUser(db, { email: mail('channel'), phone: phone(5) })
  userId = user.id
  suiteUsers.push(userId)
  cookie = await sessionCookie(env.jwtSecret, userId)
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
  await app503.close()
  await closeRedis()
  await closeClient()
})

describe('/channel/*', () => {
  it('sin sesión responde 401', async () => {
    const res = await inject(app, 'POST', '/channel/connect', { body: {} })
    expect(res.status).toBe(401)
  })

  it('sin EVOLUTION_API_URL/KEY responde 503 y no crea la instancia', async () => {
    const res = await inject(app503, 'POST', '/channel/connect', { body: {}, cookie })
    expect(res.status).toBe(503)
    const rows = await db.select().from(waInstances).where(eq(waInstances.userId, userId))
    expect(rows.length).toBe(0)
  })

  it('connect crea la instancia, fija el webhook y devuelve el QR', async () => {
    const res = await inject(app, 'POST', '/channel/connect', { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('connecting')
    expect(res.body.qrEstado).toBe('ok')
    expect(res.body.qrBase64).toBe(evo.qr.base64)

    const [row] = await db.select().from(waInstances).where(eq(waInstances.userId, userId))
    expect(row).toBeDefined()
    expect(row!.instanceName).toMatch(/^u_[0-9a-f]{32}$/)
    expect(evo.calls).toContain(`create:${row!.instanceName}`)
    expect(evo.calls).toContain(`webhook:${row!.instanceName}`)
  })

  it('connect de nuevo reusa la fila existente y llama create una sola vez', async () => {
    evo.calls.length = 0
    const res = await inject(app, 'POST', '/channel/connect', { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body.qrEstado).toBe('ok')
    const creates = evo.calls.filter((c) => c.startsWith('create:'))
    expect(creates.length).toBe(1)
  })

  it('createInstance tolera 403/409 y cualquier otro error es duro', async () => {
    const stub = (status: number, body = '{"instance":{"state":"open"}}') =>
      (async () => new Response(body, { status })) as unknown as typeof fetch
    for (const status of [403, 409]) {
      const client = createEvolutionClient({ baseUrl: 'http://evo.test', apiKey: 'k', fetch: stub(status) })
      await expect(client.createInstance('u_x')).resolves.toBeUndefined()
    }
    const roto = createEvolutionClient({ baseUrl: 'http://evo.test', apiKey: 'k', fetch: stub(500) })
    await expect(roto.createInstance('u_x')).rejects.toThrow()
  })

  it('connectionState mapea open a connected y todo fallo a disconnected', async () => {
    const json = (body: string) =>
      (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const open = createEvolutionClient({
      baseUrl: 'http://evo.test',
      apiKey: 'k',
      fetch: json('{"instance":{"state":"open"}}'),
    })
    await expect(open.connectionState('u_x')).resolves.toBe('connected')

    const cerrado = createEvolutionClient({
      baseUrl: 'http://evo.test',
      apiKey: 'k',
      fetch: json('{"instance":{"state":"close"}}'),
    })
    await expect(cerrado.connectionState('u_x')).resolves.toBe('disconnected')

    const caido = createEvolutionClient({
      baseUrl: 'http://evo.test',
      apiKey: 'k',
      fetch: (async () => {
        throw new Error('red caída')
      }) as unknown as typeof fetch,
    })
    await expect(caido.connectionState('u_x')).resolves.toBe('disconnected')
  })

  it('sync consulta el estado real y no crea nada', async () => {
    evo.state = 'connected'
    const res = await inject(app, 'POST', '/channel/sync', { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ estado: 'connected', qrEstado: 'no-aplica' })
    const [row] = await db.select().from(waInstances).where(eq(waInstances.userId, userId))
    expect(row!.state).toBe('connected')

    evo.state = 'connecting'
    evo.qr = { base64: null, code: 'PAIR-4321' }
    const conCodigo = await inject(app, 'POST', '/channel/sync', { body: {}, cookie })
    expect(conCodigo.body).toEqual({ estado: 'connecting', qrEstado: 'solo-codigo', qrBase64: null, code: 'PAIR-4321' })
  })

  it('sync de un usuario sin instancia devuelve sin-instancia y no llama a Evolution', async () => {
    const nuevo = await createDirectUser(db, { email: mail('nuevo'), phone: phone(6) })
    suiteUsers.push(nuevo.id)
    const nuevaCookie = await sessionCookie(`test-${RUN}-secret`, nuevo.id)
    evo.calls.length = 0
    const res = await inject(app, 'POST', '/channel/sync', { body: {}, cookie: nuevaCookie })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ estado: 'disconnected', qrEstado: 'sin-instancia' })
    expect(evo.calls.length).toBe(0)
  })

  it('reset pasa por logout y delete antes de recrear', async () => {
    evo.calls.length = 0
    evo.qr = { base64: 'QR-RESET', code: null }
    evo.state = 'connecting'
    const res = await inject(app, 'POST', '/channel/reset', { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body.qrBase64).toBe('QR-RESET')

    const [row] = await db.select().from(waInstances).where(eq(waInstances.userId, userId))
    const seq = evo.calls.filter(
      (c) => c.startsWith(`logout:${row!.instanceName}`) || c.startsWith(`delete:${row!.instanceName}`) || c.startsWith(`create:${row!.instanceName}`),
    )
    // el orden del array registra la secuencia: logout, delete, create
    expect(seq.indexOf(`logout:${row!.instanceName}`)).toBeLessThan(seq.indexOf(`delete:${row!.instanceName}`))
    expect(seq.indexOf(`delete:${row!.instanceName}`)).toBeLessThan(seq.indexOf(`create:${row!.instanceName}`))
  })

  it('disconnect deja la instancia en logged_out', async () => {
    const res = await inject(app, 'POST', '/channel/disconnect', { body: {}, cookie })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ estado: 'logged_out', qrEstado: 'no-aplica' })
    const [row] = await db.select().from(waInstances).where(eq(waInstances.userId, userId))
    expect(row!.state).toBe('logged_out')
  })
})
