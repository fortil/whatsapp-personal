import { and, eq, inArray } from 'drizzle-orm'
import { taskRuns, type Db, type taskKindEnum } from '@wp/db'
import { bullmqProducer, type TaskProducer } from '../queues.js'

/**
 * task_runs: la fila que el panel pollea y el job del worker actualiza. La
 * fila se crea ANTES de encolar el job y se le engancha su bullmq_job_id
 * apenas existe; si la API muere en el medio, el job que sí llegó sigue
 * funcionando porque el payload lleva el taskRunId.
 */

export type TaskKind = (typeof taskKindEnum)['enumValues'][number]

/** ¿Hay un task_run de este kind en queued|running para el usuario? (409 del sync) */
export async function hasActiveRun(db: Db, userId: string, kind: TaskKind): Promise<boolean> {
  const row = (
    await db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.userId, userId),
          eq(taskRuns.kind, kind),
          inArray(taskRuns.status, ['queued', 'running']),
        ),
      )
      .limit(1)
  )[0]
  return row !== undefined
}

/**
 * Crea el task_run (queued) y encola su job. El producer llega inyectado en
 * tests; el webhook también lo usa con el productor real de la cola.
 */
export async function startTaskRun(
  db: Db,
  opts: {
    userId: string
    kind: TaskKind
    params?: unknown
    jobName: string
    jobData: Record<string, unknown>
    producer?: TaskProducer
  },
): Promise<{ id: string; status: string } | { error: 'queue' }> {
  const [row] = await db
    .insert(taskRuns)
    .values({ userId: opts.userId, kind: opts.kind, params: opts.params ?? {} })
    .returning({ id: taskRuns.id, status: taskRuns.status })
  if (!row) return { error: 'queue' }

  try {
    const jobId = await (opts.producer ?? bullmqProducer()).add(opts.jobName, {
      ...opts.jobData,
      taskRunId: row.id,
    })
    await db.update(taskRuns).set({ bullmqJobId: jobId, updatedAt: new Date() }).where(eq(taskRuns.id, row.id))
  } catch (err) {
    // sin worker no hay tarea: la fila muerta no puede quedar girando
    console.error('[tasks] no se pudo encolar el job:', err instanceof Error ? err.message : err)
    await db
      .update(taskRuns)
      .set({ status: 'error', error: 'no se pudo encolar el job', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(taskRuns.id, row.id))
    return { error: 'queue' }
  }
  return row
}
