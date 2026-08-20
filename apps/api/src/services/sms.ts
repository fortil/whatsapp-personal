import type { Db } from '@wp/db'
import {
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  checkCode,
  consumeCodeRow,
  generateCode,
  issueCode,
  type VerificationPurpose,
} from './verification.js'

/**
 * OTP por SMS. `console` genera el código local, lo imprime al log y lo deja
 * hasheado en verification_codes: el flujo completo de dev corre sin Twilio.
 * `twilio` usa la Verify API con Basic auth por fetch (cero SDK); el código
 * vive allá y la fila local queda para rate limiting.
 */

/** Resultado de start/check: el error es un mensaje para el usuario final. */
export interface SmsResult {
  ok: boolean
  /** En español, accionable; nunca un código de error de Twilio crudo. */
  error?: string
}

export interface SmsOtpService {
  driver: 'console' | 'twilio'
  start(db: Db, input: { userId: string; phone: string; purpose: VerificationPurpose }): Promise<SmsResult>
  check(
    db: Db,
    input: { userId: string; phone: string; purpose: VerificationPurpose; code: string },
  ): Promise<SmsResult>
}

export interface SmsConfig {
  driver: 'console' | 'twilio'
  accountSid: string
  authToken: string
  verifyServiceSid: string
}

function basicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`
}

function twilioConfigured(config: SmsConfig): boolean {
  return Boolean(config.accountSid && config.authToken && config.verifyServiceSid)
}

interface TwilioErrorBody {
  code?: number
  message?: string
}

/**
 * Traduce los errores reales de Verify a algo que una persona pueda seguir.
 * El código numérico de Twilio se loguea en el servidor, no se muestra.
 */
function friendlySmsError(status: number, body: TwilioErrorBody): string {
  const message = (body.message ?? '').toLowerCase()
  if (body.code === 60200) return 'el número o el código no son válidos; pide un código nuevo'
  if (body.code === 60202) return 'agotaste los intentos de verificación; pide un código nuevo'
  if (body.code === 20429) return 'demasiadas verificaciones seguidas; espera unos minutos'
  if (body.code === 60203) return 'este número ya recibió demasiados SMS; inténtalo más tarde'
  if (
    body.code === 60201 ||
    message.includes('not deliverable') ||
    message.includes('landline') ||
    message.includes('unsupported')
  ) {
    return 'este número no puede recibir mensajes de texto'
  }
  return `no se pudo completar la verificación por SMS (HTTP ${status}); inténtalo de nuevo`
}

async function readErrorBody(res: Response): Promise<TwilioErrorBody> {
  try {
    return (await res.json()) as TwilioErrorBody
  } catch {
    return {}
  }
}

export function createSmsService(config: SmsConfig): SmsOtpService {
  if (config.driver === 'twilio') {
    return {
      driver: 'twilio',
      async start(db, input) {
        if (!twilioConfigured(config)) {
          console.error('[sms:twilio] faltan TWILIO_ACCOUNT_SID/AUTH_TOKEN/VERIFY_SERVICE_SID')
          return { ok: false }
        }
        try {
          const res = await fetch(
            `https://verify.twilio.com/v2/Services/${config.verifyServiceSid}/Verifications`,
            {
              method: 'POST',
              headers: {
                authorization: basicAuth(config.accountSid, config.authToken),
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ To: input.phone, Channel: 'sms' }),
              signal: AbortSignal.timeout(10_000),
            },
          )
          if (!res.ok) {
            const body = await readErrorBody(res)
            console.error(
              `[sms:twilio] error HTTP ${res.status} (code ${body.code ?? '?'}) enviando a ${input.phone}: ${body.message ?? ''}`,
            )
            return { ok: false, error: friendlySmsError(res.status, body) }
          }
        } catch (err) {
          console.error('[sms:twilio] fallo enviando:', err instanceof Error ? err.message : err)
          return { ok: false }
        }
        // fila sin hash: la verificación vive en Twilio, esto da rate limiting local
        await issueCode(db, { userId: input.userId, channel: 'sms', purpose: input.purpose, code: null })
        return { ok: true }
      },
      async check(db, input) {
        try {
          const res = await fetch(
            `https://verify.twilio.com/v2/Services/${config.verifyServiceSid}/VerificationCheck`,
            {
              method: 'POST',
              headers: {
                authorization: basicAuth(config.accountSid, config.authToken),
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ To: input.phone, Code: input.code }),
              signal: AbortSignal.timeout(10_000),
            },
          )
          if (!res.ok) {
            const body = await readErrorBody(res)
            console.error(
              `[sms:twilio] error HTTP ${res.status} (code ${body.code ?? '?'}) verificando ${input.phone}: ${body.message ?? ''}`,
            )
            return { ok: false, error: friendlySmsError(res.status, body) }
          }
          const body = (await res.json()) as { valid?: boolean; status?: string }
          const ok = body.valid === true || body.status === 'approved'
          if (ok) await consumeCodeRow(db, { ...input, channel: 'sms' })
          return ok ? { ok: true } : { ok: false, error: 'código inválido o expirado' }
        } catch (err) {
          console.error('[sms:twilio] fallo verificando:', err instanceof Error ? err.message : err)
          return { ok: false }
        }
      },
    }
  }

  return {
    driver: 'console',
    async start(db, input) {
      const code = generateCode()
      await issueCode(db, { userId: input.userId, channel: 'sms', purpose: input.purpose, code })
      console.log(`[sms:console] para=${input.phone} proposito=${input.purpose} codigo=${code} (expira en ${CODE_TTL_MINUTES} min)`)
      return { ok: true }
    },
    async check(db, input) {
      const ok = await checkCode(db, {
        userId: input.userId,
        purpose: input.purpose,
        code: input.code,
        channel: 'sms',
      })
      return ok ? { ok: true } : { ok: false, error: 'código inválido o expirado' }
    },
  }
}

export { MAX_CODE_ATTEMPTS }
