import { SignJWT, jwtVerify } from 'jose'

/**
 * JWT HS256 con scopes asimétricos: un token de un scope NO sirve en las
 * rutas de otro. `preauth` solo autoriza /auth/login/verify; `trusted` solo
 * sirve de atajo en el login; las sesiones llevan `user` o `admin` según el
 * rol al emitirlas. `gstate` es el state del OAuth de Google: vive 10 minutos
 * y solo autoriza /google/callback, nunca una sesión.
 */
export type TokenScope = 'user' | 'admin' | 'preauth' | 'trusted' | 'gstate'

export interface TokenPayload {
  sub: string
  scope: TokenScope
  jti?: string
}

export const SESSION_COOKIE = 'wp_session'
export const PREAUTH_COOKIE = 'wp_preauth'
export const TRUSTED_COOKIE = 'wp_trusted'

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
export const PREAUTH_TTL_SECONDS = 10 * 60
export const TRUSTED_TTL_SECONDS = 30 * 24 * 60 * 60

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signToken(
  secret: string,
  payload: TokenPayload,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ scope: payload.scope, ...(payload.jti ? { jti: payload.jti } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey(secret))
}

/** null para cualquier token inválido, expirado o firmado con otro secreto. */
export async function verifyToken(secret: string, token: string | undefined): Promise<TokenPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey(secret))
    const scope = payload.scope
    if (scope !== 'user' && scope !== 'admin' && scope !== 'preauth' && scope !== 'trusted' && scope !== 'gstate') {
      return null
    }
    if (!payload.sub) return null
    return { sub: payload.sub, scope, jti: typeof payload.jti === 'string' ? payload.jti : undefined }
  } catch {
    return null
  }
}

/** Cookie httpOnly sameSite=lax común a sesión, preauth y trusted device. */
export function authCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}
