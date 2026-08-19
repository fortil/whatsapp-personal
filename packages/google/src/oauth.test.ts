import { describe, expect, it } from 'vitest'
import { buildConsentUrl, exchangeCode, GoogleError, refreshAccessToken, revokeToken } from './index.js'

/**
 * OAuth contra dobles del fetch con la forma real de los endpoints de Google:
 * form-urlencoded al token endpoint, JSON de vuelta, y el caso en que el
 * consentimiento no entrega refresh token.
 */

const CONFIG = {
  clientId: 'client-id-de-prueba.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secreto',
  redirectUri: 'https://panel.example.com/api/google/callback',
}

interface Recorded {
  url: string
  init: RequestInit | undefined
}

function recorder(handler: (url: URL, init: RequestInit | undefined) => Response) {
  const calls: Recorded[] = []
  const fake: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString())
    calls.push({ url: input.toString(), init })
    return Promise.resolve(handler(url, init))
  }
  return { calls, fake }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('buildConsentUrl', () => {
  it('lleva scopes, offline, consent y el state', () => {
    const url = new URL(buildConsentUrl(CONFIG, 'estado-firmado'))
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email',
    )
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('estado-firmado')
  })
})

describe('exchangeCode', () => {
  it('mandó el form correcto y mapeó la respuesta', async () => {
    const { calls, fake } = recorder(() =>
      json(200, {
        access_token: 'ya29.access',
        refresh_token: '1//0g.refresh',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events',
      }),
    )
    const tokens = await exchangeCode(CONFIG, '4/0A-code', { fetch: fake })
    expect(tokens).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//0g.refresh',
      expiresIn: 3600,
      scope: 'https://www.googleapis.com/auth/calendar.events',
    })

    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    const sent = new URLSearchParams(String(calls[0]!.init?.body))
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('4/0A-code')
    expect(sent.get('client_id')).toBe(CONFIG.clientId)
    expect(sent.get('client_secret')).toBe(CONFIG.clientSecret)
    expect(sent.get('redirect_uri')).toBe(CONFIG.redirectUri)
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
  })

  it('sin refresh_token en la respuesta lo deja en null (token ya concedido antes)', async () => {
    const { fake } = recorder(() => json(200, { access_token: 'ya29.access', expires_in: 3600 }))
    const tokens = await exchangeCode(CONFIG, '4/0A-code', { fetch: fake })
    expect(tokens.refreshToken).toBeNull()
  })

  it('error HTTP llega como GoogleError con status', async () => {
    const { fake } = recorder(() => json(400, { error: 'invalid_grant' }))
    const err = await exchangeCode(CONFIG, 'code-vencido', { fetch: fake }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleError)
    expect((err as GoogleError).status).toBe(400)
  })
})

describe('refreshAccessToken', () => {
  it('refresca con grant_type=refresh_token y devuelve el access nuevo', async () => {
    const { calls, fake } = recorder(() => json(200, { access_token: 'ya29.nuevo', expires_in: 3599 }))
    const result = await refreshAccessToken(CONFIG, '1//0g.refresh', { fetch: fake })
    expect(result).toEqual({ accessToken: 'ya29.nuevo', expiresIn: 3599 })
    const sent = new URLSearchParams(String(calls[0]!.init?.body))
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('refresh_token')).toBe('1//0g.refresh')
  })

  it('token revocado: 401 con status', async () => {
    const { fake } = recorder(() => json(401, { error: 'invalid_grant' }))
    const err = await refreshAccessToken(CONFIG, '1//0g.revocado', { fetch: fake }).catch((e: unknown) => e)
    expect((err as GoogleError).status).toBe(401)
  })
})

describe('revokeToken', () => {
  it('postea el token al endpoint de revocación', async () => {
    const { calls, fake } = recorder(() => json(200, {}))
    await expect(revokeToken('1//0g.refresh', { fetch: fake })).resolves.toBe(true)
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/revoke')
    const sent = new URLSearchParams(String(calls[0]!.init?.body))
    expect(sent.get('token')).toBe('1//0g.refresh')
  })

  it('best-effort: ni error HTTP ni red rota lo lanzan', async () => {
    const failing: typeof fetch = async () => json(400, { error: 'invalid_token' })
    await expect(revokeToken('x', { fetch: failing })).resolves.toBe(false)
    const dead: typeof fetch = () => Promise.reject(new Error('red caída'))
    await expect(revokeToken('x', { fetch: dead })).resolves.toBe(false)
  })
})
