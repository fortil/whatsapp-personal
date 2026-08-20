import { cookies, headers } from 'next/headers'

/**
 * Puente panel → API. El navegador NUNCA llama a la API: todo pasa por
 * Server Components y Server Actions, con el JWT reenviado desde la cookie
 * del panel. Sin CORS, sin token en el cliente.
 */

export const API_URL = process.env.API_URL ?? 'http://localhost:3001'

export interface ApiResult<T = unknown> {
  status: number
  body: T
  /** Cabeceras set-cookie crudas de la API, para replicarlas en el panel. */
  setCookies: string[]
}

export interface Me {
  id: string
  email: string
  phone: string
  role: 'user' | 'admin'
  status: 'pending_verification' | 'pending_approval' | 'approved' | 'rejected' | 'suspended'
}

export async function apiFetch<T = unknown>(
  method: string,
  path: string,
  opts: { body?: unknown } = {},
): Promise<ApiResult<T>> {
  const requestHeaders = await headers()
  const cookieJar = await cookies()
  const forwardedFor = requestHeaders.get('x-forwarded-for')
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookieJar.toString() ? { cookie: cookieJar.toString() } : {}),
      // la API limita por IP real detrás de Caddy; el panel es el proxy ahora
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  })

  let body: T
  try {
    body = (await res.json()) as T
  } catch {
    body = null as T
  }
  return { status: res.status, body, setCookies: res.headers.getSetCookie?.() ?? [] }
}

/** En una action: replica los set-cookie de la API como cookies del panel. */
export async function applyApiCookies(setCookies: string[]): Promise<void> {
  const jar = await cookies()
  for (const raw of setCookies) {
    const [pair, ...attrs] = raw.split(';')
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    const map = new Map(
      attrs.map((a) => {
        const i = a.indexOf('=')
        return [i >= 0 ? a.slice(0, i).trim().toLowerCase() : a.trim().toLowerCase(), i >= 0 ? a.slice(i + 1).trim() : '']
      }),
    )
    const maxAge = Number(map.get('max-age'))
    if (map.has('max-age') && maxAge <= 0) {
      jar.delete(name)
      continue
    }
    jar.set(name, value, {
      httpOnly: map.has('httponly'),
      sameSite: 'lax',
      path: map.get('path') ?? '/',
      maxAge: Number.isFinite(maxAge) ? maxAge : undefined,
    })
  }
}

/**
 * Cookie meta {role, status}: solo un hint para que el middleware de Next
 * redirija sin desencriptar nada. Los layouts validan contra /auth/me; flipar
 * esta cookie a mano no abre nada.
 */
export async function setMetaCookie(user: { role: string; status: string }): Promise<void> {
  const jar = await cookies()
  jar.set('wp_meta', JSON.stringify({ role: user.role, status: user.status }), {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  })
}

export async function clearPanelCookies(): Promise<void> {
  const jar = await cookies()
  for (const name of ['wp_meta', 'wp_session', 'wp_preauth', 'wp_trusted']) jar.delete(name)
}

/** Sesión actual según la API; null si no hay cookie válida. */
export async function getMe(): Promise<Me | null> {
  const res = await apiFetch<Me>('GET', '/auth/me')
  return res.status === 200 ? res.body : null
}

export function homeFor(user: { role: string }): string {
  return user.role === 'admin' ? '/admin' : '/inicio'
}
