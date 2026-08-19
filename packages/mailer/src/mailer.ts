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

export function createMailer(opts: MailerOptions = {}): Mailer {
  const driver = opts.driver ?? (process.env.MAILER_DRIVER as MailerDriver | undefined) ?? 'console'
  const from = opts.from ?? process.env.MAIL_FROM ?? 'WhatsApp Personal <no-reply@localhost>'
  const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY
  const log = opts.log ?? console.log

  if (driver === 'resend') {
    const enabled = Boolean(apiKey && from)
    if (!enabled) log('[mailer] driver resend sin RESEND_API_KEY o MAIL_FROM: quedará en no-op')
    return {
      enabled,
      async send(msg) {
        if (!enabled) {
          log(`[mailer:noop] para=${msg.to} asunto="${msg.subject}"`)
          return false
        }
        try {
          const res = await fetch('https://api.resend.com/emails', {
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
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) {
            log(`[mailer:resend] error HTTP ${res.status} para=${msg.to}: ${await res.text().catch(() => '')}`)
            return false
          }
          return true
        } catch (err) {
          log(`[mailer:resend] fallo enviando a ${msg.to}:`, err instanceof Error ? err.message : err)
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
