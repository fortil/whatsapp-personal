/**
 * Contrato del mailer: `send` NUNCA lanza. Un correo que falla se loguea y
 * devuelve false; el flujo que lo llamó decide si continúa. Sin config
 * (driver sin API key) queda como no-op que loguea, no como error de arranque.
 */
export interface MailMessage {
  to: string
  subject: string
  html: string
  /** Versión texto plano; si falta, el driver consola imprime el html crudo. */
  text?: string
}

export interface Mailer {
  /** false cuando el driver no puede enviar nada (resend sin API key). */
  enabled: boolean
  send(msg: MailMessage): Promise<boolean>
}

export type MailerDriver = 'console' | 'resend'

type Log = (...args: unknown[]) => void

export interface MailerOptions {
  driver?: MailerDriver
  from?: string
  apiKey?: string
  /** Inyectable para tests; default console.log. */
  log?: Log
}

const RESEND_URL = 'https://api.resend.com/emails'
const RESEND_TIMEOUT_MS = 10_000
/** Tope de la espera tras un 429: respetar Retry-After sin frenar la request. */
const RETRY_AFTER_CAP_MS = 5_000
/** Backoff corto para el reintento único ante un 5xx transitorio. */
const SERVER_ERROR_BACKOFF_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry-After en segundos o como fecha HTTP. Null si falta o no se entiende:
 * sin un valor oficial del servidor no se reintenta a ciegas.
 */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS)
  }
  const at = new Date(header).getTime()
  if (!Number.isNaN(at)) {
    return Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_CAP_MS)
  }
  return null
}

export function createMailer(opts: MailerOptions = {}): Mailer {
  const driver = opts.driver ?? (process.env.MAILER_DRIVER as MailerDriver | undefined) ?? 'console'
  const from = opts.from ?? process.env.MAIL_FROM ?? 'WhatsApp Personal <no-reply@localhost>'
  const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY
  const log = opts.log ?? console.log

  if (driver === 'resend') {
    const enabled = Boolean(apiKey && from)
    if (!enabled) log('[mailer] driver resend sin RESEND_API_KEY o MAIL_FROM: quedará en no-op')
    const post = (msg: MailMessage) =>
      fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          ...(msg.text ? { text: msg.text } : {}),
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      })
    return {
      enabled,
      async send(msg) {
        if (!enabled) {
          log(`[mailer:noop] para=${msg.to} asunto="${msg.subject}"`)
          return false
        }
        try {
          let res = await post(msg)
          // reintentos acotados: solo donde el propio servidor dice que
          // reintentar tiene sentido. 401/422 son definitivos, no se reintentan
          if (res.status === 429) {
            const wait = retryAfterMs(res.headers.get('retry-after'))
            if (wait !== null) {
              await sleep(wait)
              res = await post(msg)
            }
          } else if (res.status >= 500) {
            await sleep(SERVER_ERROR_BACKOFF_MS)
            res = await post(msg)
          }
          if (res.ok) return true
          const detail = await res.text().catch(() => '')
          if (res.status === 401) {
            log('[mailer:resend] HTTP 401: la RESEND_API_KEY no es válida; los correos no salen hasta corregirla')
          } else if (res.status === 422) {
            log(
              `[mailer:resend] HTTP 422: Resend rechazó el envío (casi siempre el dominio de MAIL_FROM "${from}" sin verificar): ${detail}`,
            )
          } else {
            log(`[mailer:resend] error HTTP ${res.status} para=${msg.to}: ${detail}`)
          }
          return false
        } catch (err) {
          if (err instanceof Error && err.name === 'TimeoutError') {
            log(`[mailer:resend] timeout de ${RESEND_TIMEOUT_MS / 1000}s enviando a ${msg.to}`)
          } else {
            log(`[mailer:resend] fallo enviando a ${msg.to}:`, err instanceof Error ? err.message : err)
          }
          return false
        }
      },
    }
  }

  // driver console: el correo (y su código) queda en el log de la API. Es el
  // driver de dev; sin él no habría flujo verificable sin credenciales.
  return {
    enabled: true,
    async send(msg) {
      log(`[mailer:console] para=${msg.to} asunto="${msg.subject}"`)
      log(`[mailer:console] cuerpo:\n${msg.text ?? msg.html}`)
      return true
    },
  }
}
