import { createHash, randomInt } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { type Db, verificationCodes } from '@wp/db'

/**
 * Motor de códigos de un solo uso guardados locales (sha256, 15 min, máx 5
 * intentos). Lo usan los OTP de email siempre, y los de SMS cuando el driver
 * es `console`. Con driver `twilio` la verificación vive en Twilio y la fila
 * local queda solo para rate limiting.
 */

export type VerificationChannel = 'email' | 'sms'
export type VerificationPurpose = 'signup_email' | 'signup_phone' | 'login' | 'password_reset' | 'email_change'

export const CODE_TTL_MINUTES = 15
export const MAX_CODE_ATTEMPTS = 5

export function generateCode(): string {
  return String(randomInt(100000, 1000000))
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface IssueCodeInput {
  userId: string
  channel: VerificationChannel
  purpose: VerificationPurpose
  /** Código en claro; se guarda hasheado. Null cuando verifica un tercero (twilio). */
  code: string | null
  /**
   * Dato que queda ligado al código (hash de `code|binding`): el cambio de
   * correo liga el código al correo nuevo para que no se pueda verificar un
   * código recibido en A y aplicarlo a B.
   */
  binding?: string
}

/** Emitir invalida los anteriores del mismo (channel, purpose). */
export async function issueCode(db: Db, input: IssueCodeInput): Promise<void> {
  await db
    .update(verificationCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(verificationCodes.userId, input.userId),
        eq(verificationCodes.channel, input.channel),
        eq(verificationCodes.purpose, input.purpose),
        isNull(verificationCodes.consumedAt),
      ),
    )
  const codeHash =
    input.code === null ? null : sha256(bindingHash(input.code, input.binding))
  await db.insert(verificationCodes).values({
    userId: input.userId,
    channel: input.channel,
    purpose: input.purpose,
    codeHash,
    expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
  })
}

function bindingHash(code: string, binding?: string): string {
  return binding ? `${code}|${binding}` : code
}

export interface CheckCodeInput {
  userId: string
  purpose: VerificationPurpose
  code: string
  /** Sin channel toma el código más reciente del purpose sin consumir (login email|sms). */
  channel?: VerificationChannel
  /** Mismo binding usado al emitir; sin él el código no va a coincidir. */
  binding?: string
}

/**
 * Verifica y consume. False si no hay código vigente, si agotó los 5 intentos
 * o si no coincide. Cada intento fallido suma al contador de la fila.
 */
export async function checkCode(db: Db, input: CheckCodeInput): Promise<boolean> {
  const filters = [
    eq(verificationCodes.userId, input.userId),
    eq(verificationCodes.purpose, input.purpose),
    isNull(verificationCodes.consumedAt),
  ]
  if (input.channel) filters.push(eq(verificationCodes.channel, input.channel))

  const rows = await db
    .select()
    .from(verificationCodes)
    .where(and(...filters))
    .orderBy(desc(verificationCodes.expiresAt))
    .limit(1)
  const row = rows[0]
  if (!row) return false
  if (row.expiresAt.getTime() <= Date.now()) return false
  if (row.attempts >= MAX_CODE_ATTEMPTS) return false

  await db
    .update(verificationCodes)
    .set({ attempts: row.attempts + 1 })
    .where(eq(verificationCodes.id, row.id))

  // driver twilio: el hash local no existe, decide el caller (VerifyCheck)
  if (row.codeHash === null) return false

  if (sha256(bindingHash(input.code, input.binding)) !== row.codeHash) return false
  await db.update(verificationCodes).set({ consumedAt: new Date() }).where(eq(verificationCodes.id, row.id))
  return true
}

/** Consume la fila sin validar código: para cuando verifica Twilio. */
export async function consumeCodeRow(db: Db, input: CheckCodeInput): Promise<void> {
  const filters = [
    eq(verificationCodes.userId, input.userId),
    eq(verificationCodes.purpose, input.purpose),
    isNull(verificationCodes.consumedAt),
  ]
  if (input.channel) filters.push(eq(verificationCodes.channel, input.channel))
  const rows = await db
    .select()
    .from(verificationCodes)
    .where(and(...filters))
    .orderBy(desc(verificationCodes.expiresAt))
    .limit(1)
  const row = rows[0]
  if (!row) return
  await db
    .update(verificationCodes)
    .set({ consumedAt: new Date(), attempts: row.attempts + 1 })
    .where(eq(verificationCodes.id, row.id))
}
