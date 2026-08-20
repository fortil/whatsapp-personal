import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountApprovedEmail,
  createMailer,
  emailChangeCodeEmail,
  loginCodeEmail,
  passwordResetCodeEmail,
  pendingApprovalAdminEmail,
  signupAttemptWarningEmail,
  signupCodeEmail,
  tempPasswordEmail,
} from './index.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('driver console', () => {
  it('send devuelve true y loguea destinatario, asunto y cuerpo', async () => {
    const lines: string[] = []
    const mailer = createMailer({ driver: 'console', log: (...a) => lines.push(a.join(' ')) })
    expect(mailer.enabled).toBe(true)

    const ok = await mailer.send({ to: 'a@x.com', subject: 'hola', html: '<p>hola</p>', text: 'hola' })
    expect(ok).toBe(true)
    expect(lines.join('\n')).toContain('a@x.com')
    expect(lines.join('\n')).toContain('hola')
  })
})

describe('driver resend', () => {
  it('sin API key queda disabled y send devuelve false sin fetch', async () => {
    const log = vi.fn()
    const mailer = createMailer({ driver: 'resend', apiKey: undefined, from: undefined, log })
    expect(mailer.enabled).toBe(false)
    const ok = await mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })
    expect(ok).toBe(false)
  })

  it('con API key hace POST a resend con Bearer y el cuerpo completo', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response('{"id":"x"}', { status: 200 })
    }) as typeof fetch

    const mailer = createMailer({ driver: 'resend', apiKey: 'k-test', from: 'App <n@x.com>' })
    const ok = await mailer.send({ to: 'a@x.com', subject: 's', html: '<b>s</b>', text: 's' })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.resend.com/emails')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k-test')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body).toMatchObject({ from: 'App <n@x.com>', to: 'a@x.com', subject: 's', text: 's' })
  })

  it('429 con Retry-After: espera y reintenta una vez; si entra, true', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
      return new Response('{"id":"x"}', { status: 200 })
    }) as typeof fetch

    const mailer = createMailer({ driver: 'resend', apiKey: 'k', from: 'n@x.com' })
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(true)
    expect(calls).toBe(2)
  })

  it('429 con Retry-After como fecha HTTP: la parsea y también reintenta', async () => {
    let calls = 0
    // fecha a ~100ms: entra por la rama de Date, no por la de segundos
    const fecha = new Date(Date.now() + 100).toUTCString()
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': fecha } })
      return new Response('{"id":"x"}', { status: 200 })
    }) as typeof fetch

    const mailer = createMailer({ driver: 'resend', apiKey: 'k', from: 'n@x.com' })
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(true)
    expect(calls).toBe(2)
  })

  it('429 persistente (o sin Retry-After): false tras el reintento, sin lanzar', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
    }) as typeof fetch
    const mailer = createMailer({ driver: 'resend', apiKey: 'k', from: 'n@x.com' })
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(false)
    expect(calls).toBe(2)

    // sin Retry-After no reintenta a ciegas
    let bare = 0
    globalThis.fetch = (async () => {
      bare += 1
      return new Response('rate limited', { status: 429 })
    }) as typeof fetch
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(false)
    expect(bare).toBe(1)
  })

  it('422 de dominio no verificado: false al primer intento y log con la pista', async () => {
    let calls = 0
    const lines: string[] = []
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{"message":"The `from` field is invalid"}', { status: 422 })
    }) as typeof fetch
    const mailer = createMailer({ driver: 'resend', apiKey: 'k', from: 'App <n@dominio.com>', log: (...a) => lines.push(a.join(' ')) })
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(false)
    expect(calls).toBe(1)
    expect(lines.join('\n')).toContain('verificar')
    expect(lines.join('\n')).toContain('n@dominio.com')
  })

  it('401 de clave mala: false al primer intento, sin reintento', async () => {
    let calls = 0
    const lines: string[] = []
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{"message":"invalid api key"}', { status: 401 })
    }) as typeof fetch
    const mailer = createMailer({ driver: 'resend', apiKey: 'k-mala', from: 'n@x.com', log: (...a) => lines.push(a.join(' ')) })
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(false)
    expect(calls).toBe(1)
    expect(lines.join('\n')).toContain('RESEND_API_KEY')
  })

  it('5xx transitorio: reintenta una vez y true si entra', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response('boom', { status: 502 })
      return new Response('{"id":"x"}', { status: 200 })
    }) as typeof fetch
    const mailer = createMailer({ driver: 'resend', apiKey: 'k', from: 'n@x.com' })
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(true)
    expect(calls).toBe(2)
  })

  it('nunca lanza: HTTP 500 persistente, timeout y error de red devuelven false', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const mailer = createMailer({ driver: 'resend', apiKey: 'k', from: 'n@x.com' })
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(false)

    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    globalThis.fetch = (async () => {
      throw timeout
    }) as typeof fetch
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(false)

    globalThis.fetch = (async () => {
      throw new Error('red caída')
    }) as typeof fetch
    await expect(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' })).resolves.toBe(false)
  })
})

describe('plantillas email-safe', () => {
  it('el código va en el texto y en casillas de tabla, no en el asunto', () => {
    const mail = signupCodeEmail('123456')
    // fuera del asunto: las notificaciones del cliente de correo lo mostrarían
    expect(mail.subject).not.toContain('123456')
    expect(mail.text).toContain('123456')
    expect(mail.html).toContain('>1<')
    expect(mail.html).toContain('>6<')
    // email-safe: CSS inline en tablas, sin flex ni grid
    expect(mail.html).toContain('role="presentation"')
    expect(mail.html).not.toMatch(/display:\s*(flex|grid)/)
  })

  const ATTACK_EMAIL = 'ana<x@x.com>'
  const ATTACK_PHONE = '+573001234567<x>'
  const ATTACK_PASSWORD = 'secreto"onload=x'

  it('todas las plantillas: texto plano presente y html sin style, media queries, variables css, flex ni grid', () => {
    const mails = [
      signupCodeEmail('123456'),
      loginCodeEmail('234567'),
      passwordResetCodeEmail('345678'),
      emailChangeCodeEmail('456789'),
      pendingApprovalAdminEmail({ email: ATTACK_EMAIL, phone: ATTACK_PHONE }),
      accountApprovedEmail('https://panel.example<x>'),
      tempPasswordEmail(ATTACK_PASSWORD),
      signupAttemptWarningEmail(),
    ]
    expect(mails).toHaveLength(8)
    for (const mail of mails) {
      expect(mail.text.trim().length).toBeGreaterThan(0)
      expect(mail.html).toContain('<!DOCTYPE html>')
      expect(mail.html).toContain('role="presentation"')
      expect(mail.html).not.toContain('<style')
      expect(mail.html).not.toContain('@media')
      expect(mail.html).not.toContain('var(')
      expect(mail.html).not.toMatch(/display:\s*(flex|grid)/)
    }
  })

  it('todo dato de usuario que se interpola queda escapado en el html', () => {
    const admin = pendingApprovalAdminEmail({ email: ATTACK_EMAIL, phone: ATTACK_PHONE })
    expect(admin.html).not.toContain('<x@x.com>')
    expect(admin.html).toContain('&lt;x@x.com&gt;')

    const temp = tempPasswordEmail(ATTACK_PASSWORD)
    expect(temp.html).not.toContain('"onload=x')
    expect(temp.html).toContain('&quot;onload=x')

    const approved = accountApprovedEmail('https://panel.example?a=1"><script>')
    expect(approved.html).not.toContain('"><script>')
    expect(approved.html).toContain('href="https://panel.example?a=1&quot;&gt;&lt;script&gt;"')
  })
})
