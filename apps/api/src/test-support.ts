import type { FastifyInstance } from 'fastify'
import { users, type Db } from '@wp/db'
import type { EvolutionClient, QrResult, WaConnectionState } from '@wp/channels'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signToken } from './auth/jwt.js'
import { hashPassword } from './auth/password.js'

/**
 * Soporte de los tests de integración de canal/inbox: usuarios directos en DB,
 * cookie de sesión firmada sin pasar por el login, y un Evolution falso que
 * graba cada llamada. Cada run usa correos/celulares únicos para no pisar los
 * datos de runs anteriores.
 */

export const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`
export const mail = (n: string) => `${n}.${RUN}@mail.test`
const runTag = String(RUN.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) % 1000, 0)).padStart(3, '0')
export const phone = (n: number) => `+573002${runTag}${String(n).padStart(3, '0')}`
export const PASSWORD = 'clave-de-prueba-10'

export async function createDirectUser(
  db: Db,
  opts: { email: string; phone: string; role?: 'user' | 'admin' },
) {
  const [row] = await db
    .insert(users)
    .values({
      email: opts.email,
      phone: opts.phone,
      passwordHash: hashPassword(PASSWORD),
      role: opts.role ?? 'user',
      status: 'approved',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    })
    .returning()
  return row!
}

/** Cookie de sesión firmada con el secreto del test, sin flujo de OTP. */
export async function sessionCookie(jwtSecret: string, userId: string): Promise<string> {
  const token = await signToken(jwtSecret, { sub: userId, scope: 'user' }, SESSION_TTL_SECONDS)
  return `${SESSION_COOKIE}=${token}`
}

let ipSeq = 0
function nextIp(): string {
  ipSeq += 1
  return `10.50.${Math.floor(ipSeq / 250) % 250}.${ipSeq % 250}`
}

export async function inject(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      'x-forwarded-for': nextIp(),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  })
  let body: any = null
  try {
    body = res.json()
  } catch {
    body = null
  }
  return { status: res.statusCode, body }
}

export interface FakeEvolution extends EvolutionClient {
  calls: string[]
  state: WaConnectionState
  qr: QrResult
  nextMessageId: string | null
  failText: boolean
}

/** Evolution grabado: registra llamadas y devuelve lo que el test configura. */
export function fakeEvolution(): FakeEvolution {
  const fake: FakeEvolution = {
    calls: [],
    state: 'connecting',
    qr: { base64: 'iVBORw0KGgoAAAANSUhEUg==', code: 'ABCD-EFGH' },
    nextMessageId: null,
    failText: false,
    async createInstance(name) {
      fake.calls.push(`create:${name}`)
    },
    async setWebhook(name) {
      fake.calls.push(`webhook:${name}`)
    },
    async connectionState() {
      return fake.state
    },
    async connect() {
      fake.calls.push('connect')
      return fake.qr
    },
    async logout(name) {
      fake.calls.push(`logout:${name}`)
    },
    async deleteInstance(name) {
      fake.calls.push(`delete:${name}`)
    },
    async sendPresence() {
      fake.calls.push('presence')
    },
    async sendText(_name, { text }) {
      fake.calls.push(`sendText:${text}`)
      if (fake.failText) throw new Error('evolution caído')
      return { messageId: fake.nextMessageId ?? `OUT-${fake.calls.length}` }
    },
    async getMediaBase64() {
      return {}
    },
    async findContacts() {
      return []
    },
    async findChats() {
      return []
    },
    async findMessages() {
      return []
    },
  }
  return fake
}
