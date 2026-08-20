import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { type Db, users } from '@wp/db'
import { SESSION_COOKIE, verifyToken } from './jwt.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

export interface AuthUser {
  id: string
  email: string
  phone: string
  role: 'user' | 'admin'
  status: 'pending_verification' | 'pending_approval' | 'approved' | 'rejected' | 'suspended'
}

export interface AuthDeps {
  db: Db
  jwtSecret: string
}

/**
 * Gate de estado: cada request autenticado carga `users` por PK. Así suspender
 * o rechazar expulsa en el request siguiente; el JWT de 7 días por sí solo no
 * conserva acceso a nada.
 */
async function loadUser(deps: AuthDeps, request: FastifyRequest): Promise<AuthUser | null> {
  const token = request.cookies[SESSION_COOKIE]
  const payload = await verifyToken(deps.jwtSecret, token)
  // preauth y trusted no son sesiones: no autentican ninguna ruta
  if (!payload || (payload.scope !== 'user' && payload.scope !== 'admin')) return null

  const row = await deps.db
    .select({ id: users.id, email: users.email, phone: users.phone, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1)
  const u = row[0]
  if (!u) return null
  return { id: u.id, email: u.email, phone: u.phone, role: u.role, status: u.status }
}

/** Token de sesión válido (cualquier estado). Para /auth/me y /cuenta-ish. */
export function requireAuth(deps: AuthDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await loadUser(deps, request)
    if (!user) return reply.code(401).send({ error: 'no autenticado' })
    request.user = user
  }
}

/** Sesión válida Y cuenta aprobada: el gate transversal de las rutas de app. */
export function requireApproved(deps: AuthDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await loadUser(deps, request)
    if (!user) return reply.code(401).send({ error: 'no autenticado' })
    if (user.status !== 'approved') {
      return reply.code(403).send({ error: `cuenta ${user.status.replace('_', ' ')}` })
    }
    request.user = user
  }
}

/**
 * Admin: exige token con scope `admin` (un token scope `user` se rechaza aquí
 * aunque el rol en DB haya cambiado) + rol admin + estado aprobado leídos de
 * la DB en el mismo request.
 */
export function requireAdmin(deps: AuthDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE]
    const payload = await verifyToken(deps.jwtSecret, token)
    if (!payload || payload.scope !== 'admin') return reply.code(403).send({ error: 'solo administradores' })

    const user = await loadUser(deps, request)
    if (!user) return reply.code(401).send({ error: 'no autenticado' })
    if (user.role !== 'admin' || user.status !== 'approved') {
      return reply.code(403).send({ error: 'solo administradores' })
    }
    request.user = user
  }
}
