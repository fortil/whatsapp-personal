import { GoogleError } from './error.js'

/**
 * OAuth 2.0 de Google contra los endpoints reales, con fetch crudo (sin
 * googleapis ni SDK). El flujo completo vive en las rutas de la API:
 * consentimiento → code → exchange aquí; el refresh y la revocación los usa
 * el worker y el disconnect.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
  // people/me necesita un scope de perfil para devolver el correo de la
  // cuenta: con los dos de arriba responde sin emailAddresses y la
  // vinculación no puede guardar google_email
  'https://www.googleapis.com/auth/userinfo.email',
]

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface OAuthFetchOptions {
  /** Inyectable para tests; en producción siempre el fetch global. */
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface TokenResponse {
  accessToken: string
  /** Solo llega con access_type=offline + prompt=consent; sin él no hay nada que persistir. */
  refreshToken: string | null
  expiresIn: number | null
  scope: string | null
}

/** URL de consentimiento: access_type=offline y prompt=consent garantizan refresh token. */
export function buildConsentUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

async function tokenRequest(
  endpoint: string,
  form: URLSearchParams,
  opts: OAuthFetchOptions = {},
): Promise<Record<string, unknown>> {
  const doFetch = opts.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch (err) {
    throw new GoogleError(`no se pudo hablar con ${endpoint}: ${err instanceof Error ? err.message : err}`)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new GoogleError(`${endpoint} → ${res.status} ${detail.slice(0, 200)}`, res.status)
  }
  try {
    return JSON.parse(await res.text()) as Record<string, unknown>
  } catch {
    throw new GoogleError(`${endpoint} → respuesta no es JSON`)
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Intercambia el code del callback por tokens. El access token no se persiste. */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
  opts: OAuthFetchOptions = {},
): Promise<TokenResponse> {
  const json = await tokenRequest(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
    opts,
  )
  const accessToken = str(json.access_token)
  if (!accessToken) throw new GoogleError('la respuesta de token no trajo access_token')
  return {
    accessToken,
    refreshToken: str(json.refresh_token),
    expiresIn: num(json.expires_in),
    scope: str(json.scope),
  }
}

/** Refresh del access token: lo llama cada job con el refresh token descifrado. */
export async function refreshAccessToken(
  config: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>,
  refreshToken: string,
  opts: OAuthFetchOptions = {},
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const json = await tokenRequest(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    opts,
  )
  const accessToken = str(json.access_token)
  if (!accessToken) throw new GoogleError('la respuesta de refresh no trajo access_token')
  return { accessToken, expiresIn: num(json.expires_in) }
}

/**
 * Revoca el refresh token en Google. Best-effort: nunca lanza, porque el
 * disconnect local debe salir aunque Google esté inalcanzable (el token huérfano
 * no sirve si la fila ya no existe y la cuenta se puede revocar desde Google).
 */
export async function revokeToken(token: string, opts: OAuthFetchOptions = {}): Promise<boolean> {
  const doFetch = opts.fetch ?? fetch
  try {
    const res = await doFetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    return res.ok
  } catch (err) {
    console.error('[google] revoke falló (se ignora):', err instanceof Error ? err.message : err)
    return false
  }
}
