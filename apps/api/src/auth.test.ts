import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, like, notLike } from 'drizzle-orm'
import { closeClient, getDb, trustedDevices, users, verificationCodes, type Db } from '@wp/db'
import type { Mailer, MailMessage } from '@wp/mailer'
import { closeRedis, getRedis } from './redis.js'
import { buildApp } from './app.js'
import { readEnv } from './env.js'
import type { SmsOtpService } from './services/sms.js'
import { checkCode, generateCode, issueCode, sha256 } from './services/verification.js'
import { hashPassword } from './auth/password.js'
import { purgeRateLimits, purgeTestUsers } from './test-support.js'

/**
 * Suite de integración de la fase de auth. Corre contra el postgres y redis
 * del compose, con mailer y SMS grabados (los códigos salen de los arreglos,
 * no del log). Cada corrida usa correos, celulares e IP únicos para no pisar
 * los buckets de rate limit de redis entre runs.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`
const mail = (n: string) => `${n}.${RUN}@mail.test`
// el celular lleva marca del run: un run abortado que dejó filas no ocupa los
// números del siguiente (los correos ya lo hacen con RUN)
const runTag = String(RUN.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) % 1000, 0)).padStart(3, '0')
const phone = (n: number) => `+573001${runTag}${String(n).padStart(3, '0')}`
const ADMIN_EMAIL = mail('admin')
const PASSWORD = 'clave-de-prueba-10'

let app: FastifyInstance
let db: Db
let sentMail: MailMessage[]
let smsCodes: string[]

/** Mailer que graba en vez de imprimir: los códigos salen del texto. */
function captureMailer(): Mailer {
  return {
    enabled: true,
    async send(msg) {
      sentMail.push(msg)
      return true
    },
  }
}

/**
 * SMS grabado: mismo contrato que el driver console (código local hasheado en
 * verification_codes), pero el código queda en un arreglo para leerlo.
 */
function recordingSms(): SmsOtpService {
  return {
    driver: 'console',
    async start(db_, input) {
      const code = generateCode()
      smsCodes.push(code)
      await issueCode(db_, { userId: input.userId, channel: 'sms', purpose: input.purpose, code })
      return { ok: true }
    },
    async check(db_, input) {
      const ok = await checkCode(db_, { ...input, channel: 'sms' })
      return ok ? { ok: true } : { ok: false, error: 'código inválido o expirado' }
    },
  }
}

function codeFromMail(): string {
  const last = [...sentMail].reverse().find((m) => /\d{6}/.test(m.text ?? ''))
  if (!last) throw new Error('ningún correo con código entre los enviados')
  return (last.text ?? '').match(/\d{6}/)![0]
}

function codeFromSms(): string {
  const code = smsCodes[smsCodes.length - 1]
  if (!code) throw new Error('ningún código SMS grabado')
  return code
}

/** Cookie header armado desde los set-cookie de la respuesta inyectada. */
function cookieHeader(res: { cookies: Array<{ name: string; value: string }> }, ...names: string[]): string {
  return res.cookies
    .filter((c) => names.length === 0 || names.includes(c.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

// cada request de test sale de una IP propia: los buckets de rate limit son
// por cliente real, y la suite no debe autolimitarse entre tests
let ipSeq = 0
function nextIp(): string {
  ipSeq += 1
  return `10.40.${Math.floor(ipSeq / 250) % 250}.${ipSeq % 250}`
}

async function inject(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { body?: unknown; cookie?: string; ip?: string } = {},
): Promise<{ status: number; body: any; res: { cookies: Array<{ name: string; value: string }> } }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      'x-forwarded-for': opts.ip ?? nextIp(),
      // la API exige application/json en mutaciones; el panel manda igual
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  })
  return { status: res.statusCode, body: res.json(), res }
}

/** Signup completo hasta pending_approval: devuelve el email y el id en DB. */
async function signupToPendingApproval(email: string, ph: string, password = PASSWORD) {
  await inject('POST', '/auth/signup', { body: { phone: ph, email, password } })
  await inject('POST', '/auth/verify/email', { body: { email, code: codeFromMail() } })
  await inject('POST', '/auth/verify/phone', { body: { phone: ph, code: codeFromSms() } })
  const row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]!
  return row
}

/** Login completo (con OTP) → cookie de sesión. */
async function loginSession(identifier: string, password = PASSWORD): Promise<string> {
  const login = await inject('POST', '/auth/login', { body: { identifier, password } })
  if (login.status !== 200) throw new Error(`login falló: ${JSON.stringify(login.body)}`)
  const verify = await inject('POST', '/auth/login/verify', {
    body: { code: codeFromMail(), rememberDevice: false },
    cookie: cookieHeader(login.res),
  })
  if (verify.status !== 200) throw new Error(`verify falló: ${JSON.stringify(verify.body)}`)
  return cookieHeader(verify.res)
}

/** Usuario creado directo en DB (verified+approved) sin pasar por signup. */
async function createDirectUser(opts: {
  email: string
  phone: string
  role?: 'user' | 'admin'
  status?: 'pending_verification' | 'pending_approval' | 'approved' | 'rejected' | 'suspended'
}) {
  const [row] = await db
    .insert(users)
    .values({
      email: opts.email,
      phone: opts.phone,
      passwordHash: hashPassword(PASSWORD),
      role: opts.role ?? 'user',
      status: opts.status ?? 'approved',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    })
    .returning()
  return row!
}

beforeAll(async () => {
  db = getDb()
  await purgeTestUsers(db)
  await purgeRateLimits(getRedis())
  sentMail = []
  smsCodes = []
  const env = { ...readEnv(), jwtSecret: `test-${RUN}-secret`, adminEmail: ADMIN_EMAIL }
  app = await buildApp({ env, mailer: captureMailer(), sms: recordingSms() })
})

afterAll(async () => {
  // correos de test propios y de runs abortados de la API; sin los "worker-"
  // porque el worker corre sus suites en paralelo sobre la misma DB
  const own = and(like(users.email, '%@mail.test'), notLike(users.email, 'worker-%'))
  const testUsers = db.select({ id: users.id }).from(users).where(own)
  await db.delete(verificationCodes).where(inArray(verificationCodes.userId, testUsers)).catch(() => {})
  await db.delete(trustedDevices).where(inArray(trustedDevices.userId, testUsers)).catch(() => {})
  await db.delete(users).where(own).catch(() => {})
  await app.close()
  await closeRedis()
  await closeClient()
})

describe('health y content-type', () => {
  it('GET /health reporta db y redis', async () => {
    const res = await inject('GET', '/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', db: true, redis: true })
  })

  it('una mutación sin content-type json recibe 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': nextIp(), 'content-type': 'text/plain' },
      payload: 'hola',
    })
    expect(res.statusCode).toBe(415)
  })
})

describe('transiciones de estado del registro', () => {
  it('signup → pending_verification → verify email → verify phone → pending_approval → approve', async () => {
    const email = mail('trans')
    const ph = phone(1)

    const signup = await inject('POST', '/auth/signup', { body: { phone: ph, email, password: PASSWORD } })
    expect(signup.status).toBe(200)
    expect(signup.body.message).toContain('código')

    let row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]!
    expect(row.status).toBe('pending_verification')
    expect(row.emailVerifiedAt).toBeNull()
    // el código quedó hasheado, nunca en claro
    const codigo = codeFromMail()
    const codes = await db.select().from(verificationCodes).where(eq(verificationCodes.userId, row.id))
    expect(codes.length).toBeGreaterThan(0)
    expect(codes.some((c) => c.codeHash === sha256(codigo))).toBe(true)
    expect(codes.every((c) => c.codeHash !== codigo)).toBe(true)

    const badCode = await inject('POST', '/auth/verify/email', { body: { email, code: '000000' } })
    expect(badCode.status).toBe(400)

    const verifyEmail = await inject('POST', '/auth/verify/email', { body: { email, code: codeFromMail() } })
    expect(verifyEmail.status).toBe(200)
    expect(verifyEmail.body.next).toBe('sms')
    row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]!
    expect(row.emailVerifiedAt).not.toBeNull()
    expect(row.status).toBe('pending_verification') // el SMS no se disparó aún

    const verifyPhone = await inject('POST', '/auth/verify/phone', { body: { phone: ph, code: codeFromSms() } })
    expect(verifyPhone.status).toBe(200)
    expect(verifyPhone.body.status).toBe('pending_approval')
    row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]!
    expect(row.phoneVerifiedAt).not.toBeNull()
    // aviso al admin con los datos del pendiente
    expect(sentMail.some((m) => m.to === ADMIN_EMAIL && m.subject.includes('pendiente'))).toBe(true)

    // aprobación como admin
    const admin = await createDirectUser({ email: ADMIN_EMAIL, phone: phone(99), role: 'admin' })
    const adminSession = await loginSession(ADMIN_EMAIL)
    const approve = await inject('POST', `/admin/users/${row.id}/approve`, { cookie: adminSession })
    expect(approve.status).toBe(200)
    expect(approve.body.user.status).toBe('approved')
    const finalRow = (await db.select().from(users).where(eq(users.id, row.id)).limit(1))[0]!
    expect(finalRow.approvedBy).toBe(admin.id)
    expect(finalRow.approvedAt).not.toBeNull()
    expect(sentMail.some((m) => m.to === email && m.subject.includes('aprobada'))).toBe(true)

    // reject y reinstate
    const rej = await inject('POST', `/admin/users/${row.id}/reject`, { body: { reason: 'no' }, cookie: adminSession })
    expect(rej.body.user.status).toBe('rejected')
    const rein = await inject('POST', `/admin/users/${row.id}/reinstate`, { cookie: adminSession })
    expect(rein.body.user.status).toBe('approved')
  })

  it('el código expira o se agota: 5 intentos fallidos lo matan', async () => {
    const email = mail('intentos')
    await inject('POST', '/auth/signup', { body: { phone: phone(2), email, password: PASSWORD } })
    for (let i = 0; i < 5; i++) {
      const res = await inject('POST', '/auth/verify/email', { body: { email, code: '111111' } })
      expect(res.status).toBe(400)
    }
    // agotado: ni el código correcto pasa
    const res = await inject('POST', '/auth/verify/email', { body: { email, code: codeFromMail() } })
    expect(res.status).toBe(400)
  })
})

describe('anti-enumeración', () => {
  it('login: usuario inexistente y clave errónea responden igual', async () => {
    const real = await createDirectUser({ email: mail('enum'), phone: phone(3) })
    void real
    const noExiste = await inject('POST', '/auth/login', {
      body: { identifier: mail('nadie'), password: PASSWORD },
    })
    const claveMala = await inject('POST', '/auth/login', { body: { identifier: mail('enum'), password: 'incorrecta' } })
    expect(noExiste.status).toBe(claveMala.status)
    expect(noExiste.body).toEqual(claveMala.body)
    expect(noExiste.body.error).toBe('credenciales inválidas')
  })

  it('signup sobre correo ajeno: genérico, sin fila nueva y con aviso al dueño', async () => {
    const owner = await createDirectUser({ email: mail('dueno'), phone: phone(4) })
    const before = (await db.select({ id: users.id }).from(users)).length
    const smsAntes = smsCodes.length
    const res = await inject('POST', '/auth/signup', {
      body: { phone: phone(5), email: owner.email, password: PASSWORD },
    })
    expect(res.status).toBe(200)
    expect(res.body.message).toContain('si los datos son válidos')
    const after = (await db.select({ id: users.id }).from(users)).length
    expect(after).toBe(before)
    expect(sentMail.some((m) => m.to === owner.email && m.subject.includes('intento de registro'))).toBe(true)
    // nunca SMS a cuentas existentes
    expect(smsCodes.length).toBe(smsAntes)
  })
})

describe('anti-enumeración de verify/phone', () => {
  /**
   * SMS de twilio que falla siempre con el error específico del proveedor: si
   * la ruta filtrara el detalle, este doble lo destapa.
   */
  function twilioErroringSms(): SmsOtpService {
    return {
      driver: 'twilio',
      async start() {
        return { ok: false }
      },
      async check() {
        return { ok: false, error: 'no se pudo completar la verificación por SMS (HTTP 404); inténtalo de nuevo' }
      },
    }
  }

  async function probeApp() {
    return buildApp({
      env: { ...readEnv(), jwtSecret: `test-probe-${RUN}-secret`, adminEmail: ADMIN_EMAIL },
      mailer: captureMailer(),
      sms: twilioErroringSms(),
    })
  }

  it('teléfono registrado sin verificación abierta responde el mismo cuerpo que uno inexistente', async () => {
    const probe = await probeApp()
    try {
      const registrado = await createDirectUser({ email: mail('enum-sms'), phone: phone(18) })
      const a = await probe.inject({
        method: 'POST',
        url: '/auth/verify/phone',
        headers: { 'x-forwarded-for': '203.0.113.10', 'content-type': 'application/json' },
        payload: JSON.stringify({ phone: registrado.phone, code: '123456' }),
      })
      const b = await probe.inject({
        method: 'POST',
        url: '/auth/verify/phone',
        headers: { 'x-forwarded-for': '203.0.113.11', 'content-type': 'application/json' },
        payload: JSON.stringify({ phone: phone(998), code: '123456' }),
      })
      expect(a.statusCode).toBe(b.statusCode)
      expect(a.json()).toEqual(b.json())
      expect(a.json()).toEqual({ error: 'código inválido o expirado' })
    } finally {
      await probe.close()
    }
  })

  it('con una verificación signup_phone abierta el error específico sí se muestra', async () => {
    const probe = await probeApp()
    try {
      const u = await createDirectUser({ email: mail('enum-sms-abierta'), phone: phone(19) })
      await issueCode(db, { userId: u.id, channel: 'sms', purpose: 'signup_phone', code: null })
      const res = await probe.inject({
        method: 'POST',
        url: '/auth/verify/phone',
        headers: { 'x-forwarded-for': '203.0.113.12', 'content-type': 'application/json' },
        payload: JSON.stringify({ phone: u.phone, code: '123456' }),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'no se pudo completar la verificación por SMS (HTTP 404); inténtalo de nuevo' })
    } finally {
      await probe.close()
    }
  })

  it('rate limit: 5 por minuto por IP, el sexto recibe 429', async () => {
    const tag = RUN.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) % 250, 0)
    const ip = `198.51.100.${tag + 2}`
    await getRedis().del(`rl:verify-phone-ip:${ip}`)
    const states: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify/phone',
        headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
        payload: JSON.stringify({ phone: phone(61), code: '000000' }),
      })
      states.push(res.statusCode)
    }
    expect(states.slice(0, 5)).toEqual([400, 400, 400, 400, 400])
    expect(states[5]).toBe(429)
  })
})

describe('rate limit', () => {
  it('login: 5/min por IP, el sexto recibe 429', async () => {
    const uniqueIp = `192.0.2.${RUN.charCodeAt(3) % 250}`
    let last = 0
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': uniqueIp, 'content-type': 'application/json' },
        payload: JSON.stringify({ identifier: mail('ratelimit'), password: PASSWORD }),
      })
      last = res.statusCode
    }
    expect(last).toBe(429)
  })

  it('signup: 5 al día por IP, el sexto recibe 429', async () => {
    // IP única por run: el bucket diario vive 24h en redis y una IP repetida
    // entre runs arrancaría ya agotada (198.51.100.x no lo usa nextIp)
    const tag = RUN.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) % 250, 0)
    const ip = `198.51.100.${tag + 1}`
    // idempotencia contra un run anterior abortado sobre la misma IP
    await getRedis().del(`rl:signup-ip-day:${ip}`, `rl:signup-ip:${ip}`)
    const states: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
        payload: JSON.stringify({ phone: phone(50 + i), email: mail(`dia${i}`), password: PASSWORD }),
      })
      states.push(res.statusCode)
    }
    expect(states.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(states[5]).toBe(429)
  })

  it('reenvío: 3 por 5 minutos', async () => {
    const email = mail('resend')
    await inject('POST', '/auth/signup', { body: { phone: phone(6), email, password: PASSWORD } })
    for (let i = 0; i < 3; i++) {
      const res = await inject('POST', '/auth/verify/resend', { body: { email } })
      expect(res.status).toBe(200)
    }
    const cuarto = await inject('POST', '/auth/verify/resend', { body: { email } })
    expect(cuarto.status).toBe(429)
  })

  it('SMS de signup: 3 por teléfono al día, el cuarto no sale', async () => {
    const email = mail('sms-cap')
    const ph = phone(17)
    const smsAntes = smsCodes.length
    await inject('POST', '/auth/signup', { body: { phone: ph, email, password: PASSWORD } })
    await inject('POST', '/auth/verify/email', { body: { email, code: codeFromMail() } })
    expect(smsCodes.length).toBe(smsAntes + 1)

    // dos reenvíos más llenan el tope del teléfono (3 en el día)
    for (let i = 0; i < 2; i++) {
      const res = await inject('POST', '/auth/verify/resend', { body: { email } })
      expect(res.status).toBe(200)
    }
    expect(smsCodes.length).toBe(smsAntes + 3)

    // el cuarto intento: 429 y ningún SMS nuevo
    const cuarto = await inject('POST', '/auth/verify/resend', { body: { email } })
    expect(cuarto.status).toBe(429)
    expect(smsCodes.length).toBe(smsAntes + 3)

    // verify/email con el tope agotado responde igual pero no dispara SMS
    const row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]!
    const codigo = generateCode()
    await issueCode(db, { userId: row.id, channel: 'email', purpose: 'signup_email', code: codigo })
    const ve = await inject('POST', '/auth/verify/email', { body: { email, code: codigo } })
    expect(ve.status).toBe(200)
    expect(ve.body.next).toBe('sms')
    expect(smsCodes.length).toBe(smsAntes + 3)
  })
})

describe('scopes cruzados', () => {
  it('un token scope user no sirve en /admin y un preauth no sirve en /auth/me', async () => {
    const admin = await createDirectUser({ email: mail('scope-admin'), phone: phone(7), role: 'admin' })
    const plebeyo = await createDirectUser({ email: mail('scope-user'), phone: phone(8) })

    const adminSession = await loginSession(admin.email)
    const userSession = await loginSession(plebeyo.email)

    const lista = await inject('GET', '/admin/users', { cookie: adminSession })
    expect(lista.status).toBe(200)

    const forbidden = await inject('GET', '/admin/users', { cookie: userSession })
    expect(forbidden.status).toBe(403)

    // el preauth es solo para /auth/login/verify: no autentica nada más
    const login = await inject('POST', '/auth/login', { body: { identifier: plebeyo.email, password: PASSWORD } })
    const preauth = cookieHeader(login.res, 'wp_preauth')
    expect(preauth).toContain('wp_preauth')
    const me = await inject('GET', '/auth/me', { cookie: preauth })
    expect(me.status).toBe(401)
  })
})

describe('suspensión expulsa en el siguiente request', () => {
  it('una sesión viva muere al suspender (y /auth/me reporta el estado)', async () => {
    const admin = await createDirectUser({ email: mail('susp-admin'), phone: phone(10), role: 'admin' })
    const victima = await createDirectUser({ email: mail('susp'), phone: phone(11) })
    const adminSession = await loginSession(admin.email)
    const session = await loginSession(victima.email)

    const antes = await inject('GET', '/auth/devices', { cookie: session })
    expect(antes.status).toBe(200)

    const susp = await inject('POST', `/admin/users/${victima.id}/suspend`, { cookie: adminSession })
    expect(susp.body.user.status).toBe('suspended')

    // el JWT de 7 días sigue en la cookie, pero el gate lee users.status
    const despues = await inject('GET', '/auth/devices', { cookie: session })
    expect(despues.status).toBe(403)

    const me = await inject('GET', '/auth/me', { cookie: session })
    expect(me.status).toBe(200)
    expect(me.body.status).toBe('suspended')
  })
})

describe('trusted device', () => {
  it('con la cookie wp_trusted el login salta el OTP', async () => {
    const u = await createDirectUser({ email: mail('trusted'), phone: phone(12) })

    const login1 = await inject('POST', '/auth/login', { body: { identifier: u.email, password: PASSWORD } })
    expect(login1.body.otp).toBe('email')
    const verify = await inject('POST', '/auth/login/verify', {
      body: { code: codeFromMail(), rememberDevice: true },
      cookie: cookieHeader(login1.res),
    })
    expect(verify.status).toBe(200)
    const trusted = cookieHeader(verify.res, 'wp_trusted')
    expect(trusted).toContain('wp_trusted')
    const devices = await db.select().from(trustedDevices).where(eq(trustedDevices.userId, u.id))
    expect(devices.length).toBe(1)

    await inject('POST', '/auth/logout', { cookie: cookieHeader(verify.res) })
    const mailsAntes = sentMail.length

    const login2 = await inject('POST', '/auth/login', {
      body: { identifier: u.email, password: PASSWORD },
      cookie: trusted,
    })
    expect(login2.status).toBe(200)
    expect(login2.body.session).toBe(true)
    expect(login2.body.otp).toBeUndefined()
    // sin OTP nuevo: no se envió ningún correo
    expect(sentMail.length).toBe(mailsAntes)
  })
})

describe('typo de email recuperable por el admin', () => {
  it('el admin corrige el correo y el usuario completa el registro', async () => {
    const admin = await createDirectUser({ email: mail('typo-admin'), phone: phone(13), role: 'admin' })
    const adminSession = await loginSession(admin.email)

    // el usuario se registró con un correo tipeado mal
    const malo = mail('typo-malo')
    await inject('POST', '/auth/signup', { body: { phone: phone(14), email: malo, password: PASSWORD } })
    const row = (await db.select().from(users).where(eq(users.email, malo)).limit(1))[0]!

    // el admin lo corrige: la verificación del correo se revierte
    const bueno = mail('typo-bueno')
    const fix = await inject('PUT', `/admin/users/${row.id}/email`, { body: { email: bueno }, cookie: adminSession })
    expect(fix.status).toBe(200)
    expect(fix.body.user.email).toBe(bueno)
    const fixed = (await db.select().from(users).where(eq(users.id, row.id)).limit(1))[0]!
    expect(fixed.emailVerifiedAt).toBeNull()
    expect(fixed.status).toBe('pending_verification')

    // con el correo corregido, el usuario verifica y completa el registro
    await inject('POST', '/auth/verify/resend', { body: { email: bueno } })
    const ve = await inject('POST', '/auth/verify/email', { body: { email: bueno, code: codeFromMail() } })
    expect(ve.status).toBe(200)
    const vp = await inject('POST', '/auth/verify/phone', { body: { phone: phone(14), code: codeFromSms() } })
    expect(vp.body.status).toBe('pending_approval')
  })
})

describe('cuenta', () => {
  it('cambio de contraseña exige la actual; dispositivos se listan y revocan solo del dueño', async () => {
    const u = await createDirectUser({ email: mail('cuenta'), phone: phone(15) })
    const otro = await createDirectUser({ email: mail('cuenta-otro'), phone: phone(16) })
    const session = await loginSession(u.email)

    const mal = await inject('POST', '/auth/change-password', {
      body: { currentPassword: 'no-es', newPassword: 'nueva-clave-123' },
      cookie: session,
    })
    expect(mal.status).toBe(400)

    const bien = await inject('POST', '/auth/change-password', {
      body: { currentPassword: PASSWORD, newPassword: 'nueva-clave-123' },
      cookie: session,
    })
    expect(bien.status).toBe(200)
    const relogin = await inject('POST', '/auth/login', {
      body: { identifier: u.email, password: 'nueva-clave-123' },
    })
    expect(relogin.status).toBe(200)

    // dispositivo ajeno: el where por user_id no borra nada
    const ajeno = await db
      .insert(trustedDevices)
      .values({
        userId: otro.id,
        tokenHash: `hash-ajeno-${RUN}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning()
    const revoke = await inject('POST', `/auth/devices/${ajeno[0]!.id}/revoke`, { cookie: session })
    expect(revoke.status).toBe(404)
    const sigue = await db.select().from(trustedDevices).where(eq(trustedDevices.id, ajeno[0]!.id))
    expect(sigue.length).toBe(1)

    // y el listado no muestra dispositivos ajenos
    const lista = await inject('GET', '/auth/devices', { cookie: session })
    expect(lista.status).toBe(200)
    expect((lista.body as Array<{ id: string }>).some((d) => d.id === ajeno[0]!.id)).toBe(false)
  })
})
