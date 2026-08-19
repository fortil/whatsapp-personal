import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMailer, signupCodeEmail } from './index.js'

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

  it('nunca lanza: HTTP 500 y error de red devuelven false', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const mailer = createMailer({ driver: 'resend', apiKey: 'k', from: 'n@x.com' })
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
})
