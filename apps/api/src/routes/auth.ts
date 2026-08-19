import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, eq, or } from 'drizzle-orm'
import { type Db, trustedDevices, users } from '@wp/db'
import {
  emailChangeCodeEmail,
  loginCodeEmail,
  passwordResetCodeEmail,
  pendingApprovalAdminEmail,
  signupAttemptWarningEmail,
  signupCodeEmail,
  type Mailer,
} from '@wp/mailer'
import { normalizeCoMobile } from '@wp/shared'
import type { EvolutionClient } from '@wp/channels'
import type { Redis } from 'ioredis'
import type { ApiEnv } from '../env.js'
import {
  PREAUTH_COOKIE,
  PREAUTH_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  TRUSTED_COOKIE,
  TRUSTED_TTL_SECONDS,
  authCookieOptions,
  signToken,
  verifyToken,
} from '../auth/jwt.js'
import { requireApproved, requireAuth, type AuthUser } from '../auth/middleware.js'
import { hashPassword, verifyPasswordOrDummy } from '../auth/password.js'
import { checkRateLimit, clientIp } from '../ratelimit.js'
import type { TaskProducer } from '../queues.js'
import type { SmsOtpService } from '../services/sms.js'
import { checkCode, generateCode, issueCode, sha256 } from '../services/verification.js'

export interface RouteDeps {
  db: Db
  redis: Redis
  mailer: Mailer
  sms: SmsOtpService
  env: ApiEnv
  /** Ausente cuando falta la config de Evolution: /channel/* responde 503. */
  evolution?: EvolutionClient
  /** Productor de jobs BullMQ; inyectable para tests. Sin él se usa redis real. */
  taskQueue?: TaskProducer
}

type UserRow = typeof users.$inferSelect

const GENERIC_SIGNUP_OK = { message: 'si los datos son válidos recibirás un código en tu correo' }
const GENERIC_CODE_ERROR = 'código inválido o expirado'

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** El identificador de login es el correo o el celular en cualquier formato CO. */
function normalizeIdentifier(raw: string): { email?: string; phone?: string; invalid: boolean } {
  if (raw.includes('@')) return { email: raw.toLowerCase(), invalid: !validEmail(raw.toLowerCase()) }
  const phone = normalizeCoMobile(raw)
  if (phone) return { phone, invalid: false }
  return { invalid: true }
}

async function findByIdentifier(db: Db, identifier: string): Promise<UserRow | undefined> {
  const norm = normalizeIdentifier(identifier)
  if (norm.invalid) return undefined
  const where =
    norm.email && norm.phone
      ? or(eq(users.email, norm.email), eq(users.phone, norm.phone))
      : norm.email
        ? eq(users.email, norm.email)
        : eq(users.phone, norm.phone!)
  const rows = await db.select().from(users).where(where).limit(1)
  return rows[0]
}

/** Una fila que nunca verificó su correo puede ser tomada por el signup real. */
function takeoverEligible(user: UserRow): boolean {
  return user.status === 'pending_verification' && user.emailVerifiedAt === null
}

function publicUser(user: UserRow | AuthUser) {
  return { id: user.id, email: user.email, phone: user.phone, role: user.role, status: user.status }
}

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, redis, mailer, sms, env } = deps
  const requireSession = requireAuth({ db, jwtSecret: env.jwtSecret })
  const requireSessionApproved = requireApproved({ db, jwtSecret: env.jwtSecret })

  async function setSessionCookie(reply: FastifyReply, user: UserRow): Promise<void> {
    // scope según el rol al emitir: un token scope user nunca sirve en /admin
    const token = await signToken(
      env.jwtSecret,
      { sub: user.id, scope: user.role === 'admin' ? 'admin' : 'user' },
      SESSION_TTL_SECONDS,
    )
    reply.cookie(SESSION_COOKIE, token, authCookieOptions(SESSION_TTL_SECONDS))
  }

  // ---------- signup: email primero, SMS solo tras verificar el correo ----------

  app.post('/auth/signup', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const email = str(body?.email).toLowerCase()
    const rawPhone = str(body?.phone)
    const password = str(body?.password)

    if (!validEmail(email)) return reply.code(400).send({ error: 'correo inválido' })
    const phone = normalizeCoMobile(rawPhone)
    if (!phone) return reply.code(400).send({ error: 'celular colombiano inválido (ej. 300 123 4567)' })
    if (password.length < 10) return reply.code(400).send({ error: 'la contraseña debe tener al menos 10 caracteres' })

    const ip = clientIp(request.headers['x-forwarded-for'] as string | undefined, request.socket.remoteAddress)
    if (!(await checkRateLimit(redis, 'signup-ip', ip, 10, 60_000))) {
      return reply.code(429).send({ error: 'demasiados registros, espera un minuto' })
    }

    try {
      const byEmail = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
      if (byEmail && !takeoverEligible(byEmail)) {
        // cuenta viva con ese correo: respuesta genérica + aviso al dueño.
        // Nunca SMS: un atacante no debe poder generar costo contra cuentas ajenas.
        await mailer.send({ to: byEmail.email, ...signupAttemptWarningEmail() })
        return reply.send(GENERIC_SIGNUP_OK)
      }
      const byPhone = (await db.select().from(users).where(eq(users.phone, phone)).limit(1))[0]
      if (byPhone && !takeoverEligible(byPhone) && byPhone.id !== byEmail?.id) {
        // conflicto de teléfono: mismo genérico, con aviso al dueño de ese número
        await mailer.send({ to: byPhone.email, ...signupAttemptWarningEmail() })
        return reply.send(GENERIC_SIGNUP_OK)
      }

      const target = byEmail ?? byPhone
      if (target) {
        // fila muerta de un signup con typo: se re-intenta con los datos nuevos
        await db
          .update(users)
          .set({
            phone,
            email,
            passwordHash: hashPassword(password),
            status: 'pending_verification',
            emailVerifiedAt: null,
            phoneVerifiedAt: null,
            rejectedReason: null,
          })
          .where(eq(users.id, target.id))
      } else {
        await db.insert(users).values({
          phone,
          email,
          passwordHash: hashPassword(password),
          status: 'pending_verification',
        })
      }

      const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]!
      const code = generateCode()
      await issueCode(db, { userId: user.id, channel: 'email', purpose: 'signup_email', code })
      const sent = await mailer.send({ to: email, ...signupCodeEmail(code) })
      if (!sent) console.error(`[signup] no se pudo enviar el código a ${email}`)
      return reply.send(GENERIC_SIGNUP_OK)
    } catch (err) {
      // carrera sobre los unique de email/phone: mismo genérico que un conflicto
      if (err instanceof Error && (err as { code?: string }).code === '23505') {
        return reply.send(GENERIC_SIGNUP_OK)
      }
      throw err
    }
  })

  app.post('/auth/verify/email', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const email = str(body?.email).toLowerCase()
    const code = str(body?.code)
    const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
    // usuario inexistente y código malo comparten respuesta: nada que enumerar
    if (!user) return reply.code(400).send({ error: GENERIC_CODE_ERROR })

    const ok = await checkCode(db, { userId: user.id, purpose: 'signup_email', code, channel: 'email' })
    if (!ok) return reply.code(400).send({ error: GENERIC_CODE_ERROR })

    if (!user.emailVerifiedAt) {
      await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id))
    }
    // solo ahora se dispara el SMS: el correo ya está probado. Tope de 3 SMS
    // por teléfono al día (anti pumping): agotado, misma respuesta sin costo.
    if (await checkRateLimit(redis, 'sms-phone', user.phone, 3, 86_400_000)) {
      const started = await sms.start(db, { userId: user.id, phone: user.phone, purpose: 'signup_phone' })
      if (!started) console.error(`[verify/email] no se pudo enviar el SMS a ${user.phone}`)
    }
    return reply.send({ ok: true, next: 'sms' })
  })

  app.post('/auth/verify/phone', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const phone = normalizeCoMobile(str(body?.phone))
    const code = str(body?.code)
    if (!phone) return reply.code(400).send({ error: 'celular inválido' })
    const user = (await db.select().from(users).where(eq(users.phone, phone)).limit(1))[0]
    if (!user) return reply.code(400).send({ error: GENERIC_CODE_ERROR })

    const ok = await sms.check(db, { userId: user.id, phone, purpose: 'signup_phone', code })
    if (!ok) return reply.code(400).send({ error: GENERIC_CODE_ERROR })

    let status = user.status
    if (user.status === 'pending_verification') {
      status = 'pending_approval'
      await db
        .update(users)
        .set({ phoneVerifiedAt: new Date(), status })
        .where(eq(users.id, user.id))
      if (env.adminEmail) {
        const sent = await mailer.send({
          to: env.adminEmail,
          ...pendingApprovalAdminEmail({ email: user.email, phone: user.phone }),
        })
        if (!sent) console.error('[verify/phone] no se pudo avisar al admin')
      }
    } else if (!user.phoneVerifiedAt) {
      await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id))
    }
    return reply.send({ ok: true, status })
  })

  app.post('/auth/verify/resend', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const email = str(body?.email).toLowerCase()
    if (!(await checkRateLimit(redis, 'resend', email || 'anon', 3, 5 * 60_000))) {
      return reply.code(429).send({ error: 'demasiados reenvíos, espera unos minutos' })
    }
    const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
    if (!user) return reply.send({ ok: true })

    if (!user.emailVerifiedAt) {
      const code = generateCode()
      await issueCode(db, { userId: user.id, channel: 'email', purpose: 'signup_email', code })
      await mailer.send({ to: user.email, ...signupCodeEmail(code) })
    } else if (!user.phoneVerifiedAt) {
      // mismo tope por teléfono que en verify/email: 3 SMS al día
      if (!(await checkRateLimit(redis, 'sms-phone', user.phone, 3, 86_400_000))) {
        return reply.code(429).send({ error: 'demasiados SMS a este número hoy, intenta mañana' })
      }
      await sms.start(db, { userId: user.id, phone: user.phone, purpose: 'signup_phone' })
    }
    return reply.send({ ok: true })
  })

  // ---------- login: 2FA con trusted device y fallback SMS ----------

  app.post('/auth/login', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const identifier = str(body?.identifier)
    const password = str(body?.password)

    const ip = clientIp(request.headers['x-forwarded-for'] as string | undefined, request.socket.remoteAddress)
    if (!(await checkRateLimit(redis, 'login-ip', ip, 5, 60_000))) {
      return reply.code(429).send({ error: 'demasiados intentos, espera un minuto' })
    }
    const norm = normalizeIdentifier(identifier)
    const idKey = norm.email ?? norm.phone ?? identifier.toLowerCase()
    if (!(await checkRateLimit(redis, 'login-id', idKey, 10, 60 * 60_000))) {
      return reply.code(429).send({ error: 'demasiados intentos para esta cuenta, espera una hora' })
    }

    const user = await findByIdentifier(db, identifier)
    const passwordOk = verifyPasswordOrDummy(password, user?.passwordHash ?? null)
    // mismo cuerpo y mismo tiempo tanto si no existe como si la clave no va
    if (!user || !passwordOk) return reply.code(401).send({ error: 'credenciales inválidas' })
    if (user.status === 'rejected') return reply.code(403).send({ error: 'tu cuenta fue rechazada' })
    if (user.status === 'suspended') return reply.code(403).send({ error: 'tu cuenta está suspendida' })

    // dispositivo de confianza: sesión directa, sin OTP
    const trustedToken = request.cookies[TRUSTED_COOKIE]
    const trustedPayload = await verifyToken(env.jwtSecret, trustedToken)
    if (trustedToken && trustedPayload?.scope === 'trusted' && trustedPayload.sub === user.id) {
      const row = (
        await db
          .select()
          .from(trustedDevices)
          .where(eq(trustedDevices.tokenHash, sha256(trustedToken)))
          .limit(1)
      )[0]
      if (row && row.userId === user.id && row.expiresAt.getTime() > Date.now()) {
        await db.update(trustedDevices).set({ lastUsedAt: new Date() }).where(eq(trustedDevices.id, row.id))
        await setSessionCookie(reply, user)
        return reply.send({ session: true, user: publicUser(user) })
      }
    }

    const code = generateCode()
    await issueCode(db, { userId: user.id, channel: 'email', purpose: 'login', code })
    const sent = await mailer.send({ to: user.email, ...loginCodeEmail(code) })
    if (!sent) console.error(`[login] no se pudo enviar el código a ${user.email}; queda el fallback SMS`)

    const preauth = await signToken(env.jwtSecret, { sub: user.id, scope: 'preauth' }, PREAUTH_TTL_SECONDS)
    reply.cookie(PREAUTH_COOKIE, preauth, authCookieOptions(PREAUTH_TTL_SECONDS))
    return reply.send({ otp: 'email', user: publicUser(user) })
  })

  app.post('/auth/login/verify', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const code = str(body?.code)
    const rememberDevice = body?.rememberDevice === true || body?.rememberDevice === 'true'

    const preauth = await verifyToken(env.jwtSecret, request.cookies[PREAUTH_COOKIE])
    if (!preauth || preauth.scope !== 'preauth') {
      return reply.code(401).send({ error: 'la verificación expiró, inicia sesión de nuevo' })
    }
    const user = (await db.select().from(users).where(eq(users.id, preauth.sub)).limit(1))[0]
    if (!user) return reply.code(401).send({ error: 'la verificación expiró, inicia sesión de nuevo' })
    if (user.status === 'suspended' || user.status === 'rejected') {
      return reply.code(403).send({ error: 'tu cuenta está suspendida' })
    }

    // vale el código de email o el de SMS: el más reciente sin consumir
    const ok = await checkCode(db, { userId: user.id, purpose: 'login', code })
    if (!ok) return reply.code(400).send({ error: GENERIC_CODE_ERROR })

    reply.clearCookie(PREAUTH_COOKIE, { path: '/' })
    await setSessionCookie(reply, user)

    if (rememberDevice) {
      const jti = randomUUID()
      const token = await signToken(env.jwtSecret, { sub: user.id, scope: 'trusted', jti }, TRUSTED_TTL_SECONDS)
      await db.insert(trustedDevices).values({
        userId: user.id,
        tokenHash: sha256(token),
        userAgent: request.headers['user-agent'] ?? null,
        expiresAt: new Date(Date.now() + TRUSTED_TTL_SECONDS * 1000),
      })
      reply.cookie(TRUSTED_COOKIE, token, authCookieOptions(TRUSTED_TTL_SECONDS))
    }
    return reply.send({ ok: true, user: publicUser(user) })
  })

  app.post('/auth/login/verify/sms', async (request, reply) => {
    const preauth = await verifyToken(env.jwtSecret, request.cookies[PREAUTH_COOKIE])
    if (!preauth || preauth.scope !== 'preauth') {
      return reply.code(401).send({ error: 'la verificación expiró, inicia sesión de nuevo' })
    }
    const user = (await db.select().from(users).where(eq(users.id, preauth.sub)).limit(1))[0]
    if (!user) return reply.code(401).send({ error: 'la verificación expiró, inicia sesión de nuevo' })

    if (!(await checkRateLimit(redis, 'login-sms', user.id, 2, 60 * 60_000))) {
      return reply.code(429).send({ error: 'demasiados códigos SMS, intenta más tarde' })
    }
    const started = await sms.start(db, { userId: user.id, phone: user.phone, purpose: 'login' })
    if (!started) return reply.code(503).send({ error: 'no se pudo enviar el SMS' })
    return reply.send({ ok: true, otp: 'sms' })
  })

  // ---------- forgot / reset ----------

  app.post('/auth/forgot', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const identifier = str(body?.identifier)

    const ip = clientIp(request.headers['x-forwarded-for'] as string | undefined, request.socket.remoteAddress)
    if (!(await checkRateLimit(redis, 'forgot-ip', ip, 5, 60_000))) {
      return reply.code(429).send({ error: 'demasiadas solicitudes, espera un minuto' })
    }
    const user = await findByIdentifier(db, identifier)
    if (user) {
      const code = generateCode()
      await issueCode(db, { userId: user.id, channel: 'email', purpose: 'password_reset', code })
      await mailer.send({ to: user.email, ...passwordResetCodeEmail(code) })
    }
    return reply.send({ message: 'si la cuenta existe recibirás un código en tu correo' })
  })

  app.post('/auth/reset-password', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const email = str(body?.email).toLowerCase()
    const code = str(body?.code)
    const password = str(body?.password)
    if (password.length < 10) return reply.code(400).send({ error: 'la contraseña debe tener al menos 10 caracteres' })

    const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
    if (!user) return reply.code(400).send({ error: GENERIC_CODE_ERROR })
    const ok = await checkCode(db, { userId: user.id, purpose: 'password_reset', code, channel: 'email' })
    if (!ok) return reply.code(400).send({ error: GENERIC_CODE_ERROR })

    await db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, user.id))
    return reply.send({ ok: true })
  })

  // ---------- sesión ----------

  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    reply.clearCookie(PREAUTH_COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/auth/me', { preHandler: requireSession }, async (request) => {
    return publicUser(request.user!)
  })

  // ---------- cuenta (requiere cuenta aprobada) ----------

  app.post('/auth/change-password', { preHandler: requireSessionApproved }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const currentPassword = str(body?.currentPassword)
    const newPassword = str(body?.newPassword)
    if (newPassword.length < 10) {
      return reply.code(400).send({ error: 'la contraseña nueva debe tener al menos 10 caracteres' })
    }

    const row = (await db.select().from(users).where(eq(users.id, request.user!.id)).limit(1))[0]!
    if (!verifyPasswordOrDummy(currentPassword, row.passwordHash)) {
      return reply.code(400).send({ error: 'contraseña actual incorrecta' })
    }
    await db.update(users).set({ passwordHash: hashPassword(newPassword) }).where(eq(users.id, row.id))
    return reply.send({ ok: true })
  })

  app.post('/auth/change-email', { preHandler: requireSessionApproved }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const newEmail = str(body?.newEmail).toLowerCase()
    if (!validEmail(newEmail)) return reply.code(400).send({ error: 'correo nuevo inválido' })
    if (newEmail === request.user!.email) return reply.code(400).send({ error: 'ese ya es tu correo' })

    const taken = (await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail)).limit(1))[0]
    if (taken) return reply.code(400).send({ error: 'ese correo ya está en uso' })

    // el código queda ligado al correo nuevo (binding): un código recibido en
    // una dirección no puede aplicarse a otra
    const code = generateCode()
    await issueCode(db, {
      userId: request.user!.id,
      channel: 'email',
      purpose: 'email_change',
      code,
      binding: newEmail,
    })
    const sent = await mailer.send({ to: newEmail, ...emailChangeCodeEmail(code) })
    if (!sent) console.error(`[change-email] no se pudo enviar el código a ${newEmail}`)
    return reply.send({ ok: true })
  })

  app.post('/auth/change-email/verify', { preHandler: requireSessionApproved }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    const newEmail = str(body?.newEmail).toLowerCase()
    const code = str(body?.code)
    const ok = await checkCode(db, {
      userId: request.user!.id,
      purpose: 'email_change',
      code,
      channel: 'email',
      binding: newEmail,
    })
    if (!ok) return reply.code(400).send({ error: GENERIC_CODE_ERROR })

    await db
      .update(users)
      .set({ email: newEmail, emailVerifiedAt: new Date() })
      .where(eq(users.id, request.user!.id))
    return reply.send({ ok: true, email: newEmail })
  })

  app.get('/auth/devices', { preHandler: requireSessionApproved }, async (request) => {
    return db
      .select({
        id: trustedDevices.id,
        userAgent: trustedDevices.userAgent,
        lastUsedAt: trustedDevices.lastUsedAt,
        expiresAt: trustedDevices.expiresAt,
      })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, request.user!.id))
  })

  app.post('/auth/devices/:id/revoke', { preHandler: requireSessionApproved }, async (request, reply) => {
    const { id } = request.params as { id: string }
    // aislamiento: el where lleva user_id, el id de un dispositivo ajeno borra 0 filas
    const deleted = await db
      .delete(trustedDevices)
      .where(and(eq(trustedDevices.id, id), eq(trustedDevices.userId, request.user!.id)))
      .returning({ id: trustedDevices.id })
    if (!deleted[0]) return reply.code(404).send({ error: 'dispositivo no encontrado' })
    return reply.send({ ok: true })
  })
}
