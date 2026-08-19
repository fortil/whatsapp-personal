import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { inArray } from 'drizzle-orm'
import { closeClient, getDb, googleAccounts, taskRuns, users, type Db } from '@wp/db'
import { decryptSecret } from '@wp/google'
import { closeRedis, getRedis } from '../redis.js'
import { buildApp } from '../app.js'
import { readEnv } from '../env.js'
import { missingStartupSecrets } from '../env.js'
import { signToken, verifyToken } from '../auth/jwt.js'
import type { TaskProducer } from '../queues.js'
import { RUN, createDirectUser, inject, mail, phone, sessionCookie } from '../test-support.js'

/**
 * Rutas /google/*: degradación 503 sin credenciales, compuerta de arranque de
 * ENCRYPTION_KEY, OAuth ida y vuelta con dobles del fetch (forma real de los
 * endpoints), refresh token ilegible en reposo y encolado de los dos jobs.
 */

const JWT_SECRET = `test-google-${RUN}-secret`
const ENC_KEY = '4a'.repeat(32)
const REFRESH_TOKEN = '1//0g.refresh-token-secreto'

const googleEnv = () => ({
  ...readEnv(),
  jwtSecret: JWT_SECRET,
  googleClientId: 'client-id-test.apps.googleusercontent.com',
  googleClientSecret: 'GOCSPX-test',
  googleRedirectUri: 'https://api.test/google/callback',
  encryptionKey: ENC_KEY,
  panelUrl: 'https://panel.test',
})

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Doble del fetch de Google: token, people/me y revoke según la URL. */
function googleFetch(recorded: string[]): typeof fetch {
  return async (input: any, init?: any) => {
    const url = input.toString()
    recorded.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${String(init.body)}` : ''}`)
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json(200, { access_token: 'ya29.access', refresh_token: REFRESH_TOKEN, expires_in: 3600 })
    }
    if (url.startsWith('https://people.googleapis.com/v1/people/me')) {
      return json(200, { emailAddresses: [{ value: 'ana@gmail.com', metadata: { primary: true } }] })
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      return json(200, {})
    }
    return json(500, { error: 'endpoint no esperado en el doble' })
  }
}

let plainApp: FastifyInstance
let app: FastifyInstance
let db: Db
let userId: string
let cookie: string
const suiteUsers: string[] = []

beforeAll(async () => {
  db = getDb()
  getRedis()

  // app sin credenciales de Google: todo degrada
  const envPlain = { ...readEnv(), jwtSecret: JWT_SECRET }
  const user = await createDirectUser(db, { email: mail('googleA'), phone: phone(40) })
  userId = user.id
  suiteUsers.push(userId)
  cookie = await sessionCookie(JWT_SECRET, userId)
  plainApp = await buildApp({ env: envPlain, taskQueue: fakeProducer() })
  app = await buildApp({ env: googleEnv(), taskQueue: fakeProducer() })
})

afterAll(async () => {
  await db.delete(googleAccounts).where(inArray(googleAccounts.userId, suiteUsers)).catch(() => {})
  await db.delete(taskRuns).where(inArray(taskRuns.userId, suiteUsers)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUsers)).catch(() => {})
  await plainApp.close()
  await app.close()
  await closeRedis()
  await closeClient()
})

describe('sin credenciales de Google', () => {
  it('connect, import y callback responden 503', async () => {
    expect((await inject(plainApp, 'GET', '/google/connect', { cookie })).status).toBe(503)
    expect((await inject(plainApp, 'POST', '/google/birthdays/import', { cookie })).status).toBe(503)
    expect((await inject(plainApp, 'POST', '/google/birthdays/create-events', { cookie })).status).toBe(503)
    expect((await inject(plainApp, 'GET', '/google/callback?code=x&state=y', { cookie })).status).toBe(503)
  })

  it('status responde 200 con configured=false (el panel muestra la sección deshabilitada)', async () => {
    const res = await inject(plainApp, 'GET', '/google/status', { cookie })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ configured: false, connected: false, googleEmail: null, connectedAt: null })
  })
})

describe('missingStartupSecrets', () => {
  it('GOOGLE_* configurado sin ENCRYPTION_KEY bloquea el arranque', () => {
    const env = readEnv({ GOOGLE_CLIENT_ID: 'x' } as NodeJS.ProcessEnv)
    expect(missingStartupSecrets(env)).toContain('ENCRYPTION_KEY')
  })

  it('sin GOOGLE_* no exige ENCRYPTION_KEY', () => {
    const env = readEnv({})
    expect(missingStartupSecrets(env)).not.toContain('ENCRYPTION_KEY')
  })

  it('GOOGLE_* completo con ENCRYPTION_KEY arranca', () => {
    const env = readEnv({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', GOOGLE_REDIRECT_URI: 'z', ENCRYPTION_KEY: ENC_KEY } as NodeJS.ProcessEnv)
    expect(missingStartupSecrets(env)).toEqual(['JWT_SECRET', 'WEBHOOK_SECRET'])
  })
})

describe('con credenciales de Google', () => {
  it('sin sesión: 401', async () => {
    expect((await inject(app, 'GET', '/google/connect')).status).toBe(401)
  })

  it('connect devuelve la URL de consentimiento con state JWT de 10 min atado al usuario', async () => {
    const res = await inject(app, 'GET', '/google/connect', { cookie })
    expect(res.status).toBe(200)
    const url = new URL(res.body.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('calendar.events')
    expect(url.searchParams.get('scope')).toContain('contacts.readonly')

    const payload = await verifyToken(JWT_SECRET, url.searchParams.get('state') ?? undefined)
    expect(payload?.scope).toBe('gstate')
    expect(payload?.sub).toBe(userId)
  })

  it('import y create-events sin cuenta vinculada: 400', async () => {
    expect((await inject(app, 'POST', '/google/birthdays/import', { cookie })).status).toBe(400)
    expect((await inject(app, 'POST', '/google/birthdays/create-events', { cookie })).status).toBe(400)
  })

  it('callback con state inválido redirige al panel con error', async () => {
    const res = await app.inject({ method: 'GET', url: '/google/callback?code=x&state=firmado-por-otro' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('https://panel.test/google?error=')
  })

  it('callback con access_denied redirige con el motivo', async () => {
    const state = await signToken(JWT_SECRET, { sub: userId, scope: 'gstate' }, 600)
    const res = await app.inject({ method: 'GET', url: `/google/callback?error=access_denied&state=${state}` })
    expect(res.statusCode).toBe(302)
    expect(decodeURIComponent(res.headers.location!)).toContain('no aceptaste los permisos')
  })

  it('callback válido: guarda la cuenta con el refresh token ilegible y redirige', async () => {
    const recorded: string[] = []
    vi.stubGlobal('fetch', googleFetch(recorded))
    try {
      const state = await signToken(JWT_SECRET, { sub: userId, scope: 'gstate' }, 600)
      const res = await app.inject({ method: 'GET', url: `/google/callback?code=4/0A-code&state=${state}` })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://panel.test/google')
    } finally {
      vi.unstubAllGlobals()
    }

    const row = (await db.select().from(googleAccounts).where(inArray(googleAccounts.userId, [userId])))[0]
    expect(row).toBeDefined()
    expect(row!.googleEmail).toBe('ana@gmail.com')
    // ilegible en reposo…
    expect(row!.refreshTokenEnc).not.toContain(REFRESH_TOKEN)
    expect(row!.refreshTokenEnc).not.toContain('refresh-token-secreto')
    // …pero descifra con la key correcta
    expect(decryptSecret(ENC_KEY, row!.refreshTokenEnc)).toBe(REFRESH_TOKEN)

    // el doble vio el exchange y el profile, nada más
    expect(recorded.some((r) => r.includes('oauth2.googleapis.com/token'))).toBe(true)
    expect(recorded.some((r) => r.includes('people/me'))).toBe(true)
    expect(recorded).toHaveLength(2)
  })

  it('status conectado reporta el correo', async () => {
    const res = await inject(app, 'GET', '/google/status', { cookie })
    expect(res.status).toBe(200)
    expect(res.body.configured).toBe(true)
    expect(res.body.connected).toBe(true)
    expect(res.body.googleEmail).toBe('ana@gmail.com')
  })

  it('import y create-events encolan sus jobs; repetir en curso da 409', async () => {
    const producer = fakeProducer()
    const appWithProducer = await buildApp({ env: googleEnv(), taskQueue: producer })
    try {
      const first = await inject(appWithProducer, 'POST', '/google/birthdays/import', { cookie })
      expect(first.status).toBe(200)
      expect(producer.calls.map((c) => c.name)).toEqual(['birthday_import'])
      expect(producer.calls[0]!.data).toMatchObject({ userId })

      const repeat = await inject(appWithProducer, 'POST', '/google/birthdays/import', { cookie })
      expect(repeat.status).toBe(409)

      const events = await inject(appWithProducer, 'POST', '/google/birthdays/create-events', { cookie })
      expect(events.status).toBe(200)
      expect(producer.calls.map((c) => c.name)).toEqual(['birthday_import', 'birthday_calendar_sync'])
    } finally {
      await appWithProducer.close()
    }
  })

  it('disconnect revoca en Google y borra la cuenta', async () => {
    const recorded: string[] = []
    vi.stubGlobal('fetch', googleFetch(recorded))
    try {
      const res = await inject(app, 'POST', '/google/disconnect', { cookie })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }

    const rows = await db.select().from(googleAccounts).where(inArray(googleAccounts.userId, [userId]))
    expect(rows).toHaveLength(0)

    const revoke = recorded.find((r) => r.startsWith('POST https://oauth2.googleapis.com/revoke'))
    expect(revoke).toBeDefined()
    expect(revoke).toContain(encodeURIComponent(REFRESH_TOKEN).slice(0, 10))

    const status = await inject(app, 'GET', '/google/status', { cookie })
    expect(status.body.connected).toBe(false)
  })
})
