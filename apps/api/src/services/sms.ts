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
export interface SmsOtpService {
  driver: 'console' | 'twilio'
  start(db: Db, input: { userId: string; phone: string; purpose: VerificationPurpose }): Promise<boolean>
  check(db: Db, input: { userId: string; phone: string; purpose: VerificationPurpose; code: string }): Promise<boolean>
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

export function createSmsService(config: SmsConfig): SmsOtpService {
  if (config.driver === 'twilio') {
    return {
      driver: 'twilio',
      async start(db, input) {
        if (!twilioConfigured(config)) {
          console.error('[sms:twilio] faltan TWILIO_ACCOUNT_SID/AUTH_TOKEN/VERIFY_SERVICE_SID')
          return false
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
            console.error(`[sms:twilio] error HTTP ${res.status} enviando a ${input.phone}`)
            return false
          }
        } catch (err) {
          console.error('[sms:twilio] fallo enviando:', err instanceof Error ? err.message : err)
          return false
        }
        // fila sin hash: la verificación vive en Twilio, esto da rate limiting local
        await issueCode(db, { userId: input.userId, channel: 'sms', purpose: input.purpose, code: null })
        return true
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
            console.error(`[sms:twilio] error HTTP ${res.status} verificando ${input.phone}`)
            return false
          }
          const body = (await res.json()) as { valid?: boolean; status?: string }
          const ok = body.valid === true || body.status === 'approved'
          if (ok) await consumeCodeRow(db, { ...input, channel: 'sms' })
          return ok
        } catch (err) {
          console.error('[sms:twilio] fallo verificando:', err instanceof Error ? err.message : err)
          return false
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
      return true
    },
    async check(db, input) {
      return checkCode(db, {
        userId: input.userId,
        purpose: input.purpose,
        code: input.code,
        channel: 'sms',
      })
    },
  }
}

export { MAX_CODE_ATTEMPTS }
