import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { taskRuns } from '@wp/db'
import { requireApproved } from '../auth/middleware.js'
import type { RouteDeps } from './auth.js'

/**
 * task_runs: lista, detalle y descarga del archivo generado. Todo filtra
 * user_id — que el usuario B no descargue el archivo de A es criterio de
 * aceptación de esta fase, no un detalle.
 */

const LIST_LIMIT = 50

function publicTaskRun(row: typeof taskRuns.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    processed: row.processed,
    total: row.total,
    error: row.error,
    hasFile: Boolean(row.filePath),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }
}

export function registerTaskRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, env } = deps
  const requireApprovedHook = requireApproved({ db, jwtSecret: env.jwtSecret })

  app.register(async (scope) => {
    scope.addHook('preHandler', requireApprovedHook)

    scope.get('/tasks', async (request) => {
      const rows = await db
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.userId, request.user!.id))
        .orderBy(desc(taskRuns.updatedAt))
        .limit(LIST_LIMIT)
      return { items: rows.map(publicTaskRun) }
    })

    scope.get('/tasks/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = (
        await db
          .select()
          .from(taskRuns)
          .where(and(eq(taskRuns.id, id), eq(taskRuns.userId, request.user!.id)))
          .limit(1)
      )[0]
      if (!row) return reply.code(404).send({ error: 'tarea no encontrada' })
      return reply.send(publicTaskRun(row))
    })

    scope.get('/tasks/:id/download', async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = (
        await db
          .select()
          .from(taskRuns)
          .where(and(eq(taskRuns.id, id), eq(taskRuns.userId, request.user!.id)))
          .limit(1)
      )[0]
      // 404 tanto si la tarea no es del usuario como si no tiene archivo: no
      // se distingue "no existe" de "no es tuya" en la respuesta
      if (!row || !row.filePath) return reply.code(404).send({ error: 'archivo no encontrado' })

      try {
        await stat(row.filePath)
      } catch {
        return reply.code(404).send({ error: 'archivo no encontrado' })
      }

      reply.header('content-disposition', `attachment; filename="contactos-${id}.xlsx"`)
      reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      return reply.send(createReadStream(row.filePath))
    })
  })
}
