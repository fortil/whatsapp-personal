import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { closeClient, getDb, users, verificationCodes, type Db } from '@wp/db'
import { closeRedis, getRedis } from '../redis.js'
import { createSmsService } from './sms.js'
import { createDirectUser, mail, phone, purgeTestUsers } from '../test-support.js'

/**
 * Driver twilio contra dobles de fetch que reproducen las respuestas reales
 * de la Verify API (201 en start, 200 approved/pending en check, 400 con el
 * código de error de Twilio en el body). Sin credenciales reales: lo que se
 * prueba es el protocolo y el mensaje que la persona ve.
 */

const realFetch = globalThis.fetch

let db: Db
let userId: string

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Servicio twilio con fetch doble. `respond` recibe la URL y el cuerpo
 * form-encoded de cada llamada y devuelve la respuesta.
 */
function withTwilio(respond: (url: string, body: string) => Response) {
  const calls: Array<{ url: string; auth: string; body: string }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string>)?.authorization ?? ''),
      body: String(init?.body ?? ''),
    })
    return respond(String(url), String(init?.body ?? ''))
  }) as typeof fetch
  return {
    calls,
    service: createSmsService({
      driver: 'twilio',
      accountSid: 'ACtest',
      authToken: 'token-test',
      verifyServiceSid: 'VAtest',
    }),
  }
}

async function freshCodeRow() {
  return (
    await db
      .select()
      .from(verificationCodes)
      .where(and(eq(verificationCodes.userId, userId), isNull(verificationCodes.consumedAt)))
      .orderBy(desc(verificationCodes.expiresAt))
      .limit(1)
  )[0]
}

const INPUT = { phone: '+573001234567' }

beforeAll(async () => {
  db = getDb()
  getRedis()
  await purgeTestUsers(db)
  const user = await createDirectUser(db, { email: mail('smstwilio'), phone: phone(70) })
  userId = user.id
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await db.delete(verificationCodes).where(eq(verificationCodes.userId, userId)).catch(() => {})
  await db.delete(users).where(eq(users.id, userId)).catch(() => {})
  await closeRedis()
  await closeClient()
})

describe('driver twilio: start', () => {
  it('201: deja fila local sin hash (rate limiting) y llama a Verify con Basic auth', async () => {
    const { service, calls } = withTwilio(() => json(201, { status: 'pending', to: INPUT.phone }))
    const res = await service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://verify.twilio.com/v2/Services/VAtest/Verifications')
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('ACtest:token-test').toString('base64')}`)
    expect(calls[0]!.body).toBe('To=%2B573001234567&Channel=sms')
    const row = await freshCodeRow()
    expect(row).toBeDefined()
    expect(row!.codeHash).toBeNull()
  })

  it('60203 (demasiados envíos al número): ok false con mensaje entendible', async () => {
    const { service } = withTwilio(() =>
      json(400, { code: 60203, message: 'Max send attempts reached' }),
    )
    const res = await service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('demasiados SMS')
    expect(res.error).not.toContain('60203')
  })

  it('60200 (parámetro inválido): mensaje entendible', async () => {
    const { service } = withTwilio(() =>
      json(400, { code: 60200, message: 'Invalid parameter: To' }),
    )
    const res = await service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no son válidos')
  })

  it('60201 (línea fija): mensaje entendible', async () => {
    const { service } = withTwilio(() =>
      json(400, { code: 60201, message: 'Landline or otherwise unsupported phone number' }),
    )
    const res = await service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no puede recibir mensajes de texto')
    expect(res.error).not.toContain('60201')
  })

  it('número no entregable: mensaje entendible aunque el código no sea conocido', async () => {
    const { service } = withTwilio(() =>
      json(400, { message: 'Phone number is not deliverable' }),
    )
    const res = await service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no puede recibir mensajes de texto')
  })

  it('error de red o timeout: ok false sin lanzar', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const service = createSmsService({
      driver: 'twilio',
      accountSid: 'ACtest',
      authToken: 'token-test',
      verifyServiceSid: 'VAtest',
    })
    await expect(service.start(db, { userId, purpose: 'signup_phone', ...INPUT })).resolves.toEqual({ ok: false })
  })

  it('sin credenciales completas: ok false sin llamar a la API', async () => {
    let called = 0
    globalThis.fetch = (async () => {
      called += 1
      return json(201, {})
    }) as typeof fetch
    const service = createSmsService({
      driver: 'twilio',
      accountSid: 'ACtest',
      authToken: '',
      verifyServiceSid: 'VAtest',
    })
    const res = await service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    expect(res).toEqual({ ok: false })
    expect(called).toBe(0)
  })
})

describe('driver twilio: check', () => {
  it('approved: ok true y consume la fila local', async () => {
    const start = withTwilio(() => json(201, { status: 'pending' }))
    await start.service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    const check = withTwilio(() => json(200, { status: 'approved', valid: true }))
    const res = await check.service.check(db, { userId, purpose: 'signup_phone', code: '123456', ...INPUT })
    expect(res.ok).toBe(true)
    const row = await freshCodeRow()
    expect(row).toBeUndefined()
  })

  it('pending (código malo): ok false con el genérico, fila sigue viva', async () => {
    const start = withTwilio(() => json(201, { status: 'pending' }))
    await start.service.start(db, { userId, purpose: 'signup_phone', ...INPUT })
    const check = withTwilio(() => json(200, { status: 'pending', valid: false }))
    const res = await check.service.check(db, { userId, purpose: 'signup_phone', code: '000000', ...INPUT })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('código inválido o expirado')
    expect(await freshCodeRow()).toBeDefined()
  })

  it('60202 (máximo de intentos de check): mensaje entendible', async () => {
    const { service } = withTwilio(() =>
      json(400, { code: 60202, message: 'Too many concurrent requests' }),
    )
    const res = await service.check(db, { userId, purpose: 'signup_phone', code: '123456', ...INPUT })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('agotaste los intentos')
    expect(res.error).not.toContain('60202')
  })

  it('20429 (rate limit): mensaje entendible', async () => {
    const { service } = withTwilio(() =>
      json(429, { code: 20429, message: 'Too many requests' }),
    )
    const res = await service.check(db, { userId, purpose: 'signup_phone', code: '123456', ...INPUT })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('espera unos minutos')
  })

  it('error de red: ok false sin lanzar', async () => {
    globalThis.fetch = (async () => {
      throw new Error('timeout')
    }) as typeof fetch
    const service = createSmsService({
      driver: 'twilio',
      accountSid: 'ACtest',
      authToken: 'token-test',
      verifyServiceSid: 'VAtest',
    })
    await expect(
      service.check(db, { userId, purpose: 'signup_phone', code: '123456', ...INPUT }),
    ).resolves.toEqual({ ok: false })
  })
})

describe('driver console (contrato igual de results)', () => {
  it('start ok y check con código malo devuelve el genérico', async () => {
    globalThis.fetch = realFetch
    const service = createSmsService({ driver: 'console', accountSid: '', authToken: '', verifyServiceSid: '' })
    const started = await service.start(db, { userId, purpose: 'login', ...INPUT })
    expect(started.ok).toBe(true)
    const checked = await service.check(db, { userId, purpose: 'login', code: '000000', ...INPUT })
    expect(checked).toEqual({ ok: false, error: 'código inválido o expirado' })
  })
})
