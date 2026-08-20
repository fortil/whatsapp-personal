import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { taskRuns, users, waInstances } from '@wp/db'
import { accountApprovedEmail, tempPasswordEmail } from '@wp/mailer'
import { requireAdmin } from '../auth/middleware.js'
import { hashPassword } from '../auth/password.js'
import type { RouteDeps } from './auth.js'

const STATUSES = ['pending_verification', 'pending_approval', 'approved', 'rejected', 'suspended'] as const
type Status = (typeof STATUSES)[number]

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function publicRow(user: typeof users.$inferSelect) {
  const { passwordHash: _omitida, ...rest } = user
  return rest
}

export function registerAdminRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, mailer, env } = deps
  const requireAdminHook = requireAdmin({ db, jwtSecret: env.jwtSecret })

  async function findUser(id: string) {
    return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  }

  app.register(async (adminScope) => {
    adminScope.addHook('preHandler', requireAdminHook)

    adminScope.get('/admin/users', async (request, reply) => {
      const query = request.query as { status?: string }
      const raw = query.status?.trim() ?? ''
      // catálogo cerrado: cualquier otra cosa es un 400, no una lista vacía
      if (raw && !STATUSES.includes(raw as Status)) {
        return reply.code(400).send({ error: 'estado inválido' })
      }
      const status = (raw || undefined) as Status | undefined
      const rows = status
        ? await db
            .select()
            .from(users)
            .where(eq(users.status, status))
            .orderBy(users.email)
        : await db.select().from(users).orderBy(users.email)
      return rows.map(publicRow)
    })

    adminScope.post('/admin/users/:id/approve', async (request, reply) => {
      const { id } = request.params as { id: string }
      const admin = request.user!
      const user = await findUser(id)
      if (!user) return reply.code(404).send({ error: 'usuario no encontrado' })
      if (user.status === 'approved') return reply.code(400).send({ error: 'ya está aprobado' })
      if (user.status === 'rejected') return reply.code(400).send({ error: 'está rechazado: usa reinstate' })

      const [updated] = await db
        .update(users)
        .set({ status: 'approved', approvedAt: new Date(), approvedBy: admin.id, rejectedReason: null })
        .where(eq(users.id, id))
        .returning()
      const sent = await mailer.send({ to: updated!.email, ...accountApprovedEmail(env.panelUrl) })
      if (!sent) console.error(`[admin/approve] no se pudo avisar a ${updated!.email}`)
      return reply.send({ ok: true, user: publicRow(updated!) })
    })

    adminScope.post('/admin/users/:id/reject', async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown> | undefined
      const reason = str(body?.reason) || null
      const user = await findUser(id)
      if (!user) return reply.code(404).send({ error: 'usuario no encontrado' })
      if (user.status === 'rejected') return reply.code(400).send({ error: 'ya está rechazado' })

      const [updated] = await db
        .update(users)
        .set({ status: 'rejected', rejectedReason: reason })
        .where(eq(users.id, id))
        .returning()
      return reply.send({ ok: true, user: publicRow(updated!) })
    })

    adminScope.post('/admin/users/:id/suspend', async (request, reply) => {
      const { id } = request.params as { id: string }
      const user = await findUser(id)
      if (!user) return reply.code(404).send({ error: 'usuario no encontrado' })
      if (user.status === 'suspended') return reply.code(400).send({ error: 'ya está suspendido' })

      const [updated] = await db.update(users).set({ status: 'suspended' }).where(eq(users.id, id)).returning()
      // el gate de estado lee la DB en cada request: el JWT de 7d ya no sirve
      return reply.send({ ok: true, user: publicRow(updated!) })
    })

    adminScope.post('/admin/users/:id/reinstate', async (request, reply) => {
      const { id } = request.params as { id: string }
      const admin = request.user!
      const user = await findUser(id)
      if (!user) return reply.code(404).send({ error: 'usuario no encontrado' })
      if (user.status !== 'suspended' && user.status !== 'rejected') {
        return reply.code(400).send({ error: 'solo se reincorporan cuentas suspendidas o rechazadas' })
      }

      const [updated] = await db
        .update(users)
        .set({ status: 'approved', approvedBy: admin.id, rejectedReason: null })
        .where(eq(users.id, id))
        .returning()
      return reply.send({ ok: true, user: publicRow(updated!) })
    })

    adminScope.post('/admin/users/:id/reset-password', async (request, reply) => {
      const { id } = request.params as { id: string }
      const user = await findUser(id)
      if (!user) return reply.code(404).send({ error: 'usuario no encontrado' })

      // 12 caracteres de base64url: fuerza suficiente y tipeable
      const tempPassword = randomBytes(9).toString('base64url')
      await db.update(users).set({ passwordHash: hashPassword(tempPassword) }).where(eq(users.id, id))
      const sent = await mailer.send({ to: user.email, ...tempPasswordEmail(tempPassword) })
      if (!sent) console.error(`[admin/reset-password] no se pudo avisar a ${user.email}`)
      // la contraseña va por correo (o al log con driver console), no en la respuesta
      return reply.send({ ok: true })
    })

    adminScope.put('/admin/users/:id/email', async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown> | undefined
      const email = str(body?.email).toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'correo inválido' })

      const user = await findUser(id)
      if (!user) return reply.code(404).send({ error: 'usuario no encontrado' })
      if (email !== user.email) {
        const taken = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]
        if (taken) return reply.code(400).send({ error: 'ese correo ya está en uso' })
        // correo nuevo sin probar: se revierte la verificación y el usuario
        // re-verifica desde /verificar
        await db.update(users).set({ email, emailVerifiedAt: null }).where(eq(users.id, id))
      }
      const updated = await findUser(id)
      return reply.send({ ok: true, user: publicRow(updated!) })
    })

    adminScope.get('/admin/overview', async () => {
      const byStatus = await db
        .select({ status: users.status, count: sql<number>`count(*)::int` })
        .from(users)
        .groupBy(users.status)

      const instancesByState = await db
        .select({ state: waInstances.state, count: sql<number>`count(*)::int` })
        .from(waInstances)
        .groupBy(waInstances.state)

      const failedTasks = await db
        .select({
          id: taskRuns.id,
          userId: taskRuns.userId,
          kind: taskRuns.kind,
          error: taskRuns.error,
          updatedAt: taskRuns.updatedAt,
        })
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.status, 'error'),
            gte(taskRuns.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
          ),
        )
        .orderBy(desc(taskRuns.updatedAt))
        .limit(20)

      return {
        usersByStatus: byStatus,
        instancesByState,
        failedTasksLast24h: failedTasks,
      }
    })
  })
}
