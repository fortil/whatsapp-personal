import { stat, unlink } from 'node:fs/promises'
import { and, eq, lt } from 'drizzle-orm'
import { messages, taskRuns, type Db } from '@wp/db'

/**
 * Reaper del worker: barridos periódicos de lo que un crash o un reinicio
 * deja a medias. Exportado y con `db` por parámetro para poder probarlo sin
 * arrancar el worker completo (que abre Redis y bindea el puerto de health).
 * Este archivo es el único punto donde se agregan barridos nuevos.
 */

export const DEFAULT_STUCK_TRANSCRIPTION_THRESHOLD_MS = 10 * 60_000
export const DEFAULT_STUCK_TASK_THRESHOLD_MS = 15 * 60_000
export const DEFAULT_EXPORT_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/** Marca 'error' los mensajes 'pending' con `transcribeStartedAt` viejo. Devuelve cuántos tocó. */
export async function sweepStuckTranscriptions(
  db: Db,
  thresholdMs: number = DEFAULT_STUCK_TRANSCRIPTION_THRESHOLD_MS,
): Promise<number> {
  const threshold = new Date(Date.now() - thresholdMs)
  const stuck = await db
    .update(messages)
    .set({ transcriptStatus: 'error' })
    .where(and(eq(messages.transcriptStatus, 'pending'), lt(messages.transcribeStartedAt, threshold)))
    .returning({ id: messages.id })
  return stuck.length
}

/**
 * task_runs 'running' estancados (updated_at viejo) cuyo job de BullMQ ya no
 * está activo quedan en error "interrumpido": la barra del panel no puede
 * quedarse girando para siempre sobre un job que murió con el worker.
 * isActiveJob la cablea index.ts contra BullMQ; sin ella se decide solo por
 * reloj (el worker corre a concurrencia 1).
 */
export async function sweepStuckTaskRuns(
  db: Db,
  thresholdMs: number = DEFAULT_STUCK_TASK_THRESHOLD_MS,
  isActiveJob: (bullmqJobId: string) => Promise<boolean> = async () => false,
): Promise<number> {
  const threshold = new Date(Date.now() - thresholdMs)
  const candidates = await db
    .select({ id: taskRuns.id, bullmqJobId: taskRuns.bullmqJobId })
    .from(taskRuns)
    .where(and(eq(taskRuns.status, 'running'), lt(taskRuns.updatedAt, threshold)))

  let interrupted = 0
  for (const row of candidates) {
    if (row.bullmqJobId && (await isActiveJob(row.bullmqJobId))) continue
    const updated = await db
      .update(taskRuns)
      .set({ status: 'error', error: 'interrumpido', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(taskRuns.id, row.id), eq(taskRuns.status, 'running')))
      .returning({ id: taskRuns.id })
    interrupted += updated.length
  }
  return interrupted
}

/**
 * Archivos de EXPORT_DIR con más de maxAgeMs: se borran y se limpia el
 * file_path de su task_run. También limpia los file_path que apuntan a
 * archivos que ya no existen (disco limpiado a mano). Devuelve cuántos
 * archivos borró.
 */
export async function sweepOldExports(
  db: Db,
  exportDir: string,
  maxAgeMs: number = DEFAULT_EXPORT_MAX_AGE_MS,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs
  const withFile = await db
    .select({ id: taskRuns.id, filePath: taskRuns.filePath })
    .from(taskRuns)
    .where(eq(taskRuns.kind, 'contacts_export'))

  let removed = 0
  for (const row of withFile) {
    if (!row.filePath) continue
    try {
      const info = await stat(row.filePath)
      if (info.mtimeMs >= cutoff) continue
      await unlink(row.filePath)
      removed += 1
    } catch {
      // el archivo ya no existe: la fila no debe seguir ofreciendo una
      // descarga rota, se limpia igual
    }
    await db.update(taskRuns).set({ filePath: null, updatedAt: new Date() }).where(eq(taskRuns.id, row.id))
  }
  return removed
}

export interface ReaperOptions {
  exportDir?: string
  stuckTaskThresholdMs?: number
  exportMaxAgeMs?: number
  isActiveJob?: (bullmqJobId: string) => Promise<boolean>
}

/** Un ciclo del barrido completo, con el log que espera el operador del worker. */
export async function runReaperSweep(db: Db, opts: ReaperOptions = {}): Promise<void> {
  const stuckTranscriptions = await sweepStuckTranscriptions(db)
  if (stuckTranscriptions > 0) {
    console.error(`[worker] reaper: ${stuckTranscriptions} transcripción(es) colgada(s) marcada(s) como error`)
  }

  const interrupted = await sweepStuckTaskRuns(db, opts.stuckTaskThresholdMs, opts.isActiveJob)
  if (interrupted > 0) {
    console.error(`[worker] reaper: ${interrupted} task_run(s) interrumpido(s) marcado(s) como error`)
  }

  if (opts.exportDir) {
    const removed = await sweepOldExports(db, opts.exportDir, opts.exportMaxAgeMs)
    if (removed > 0) {
      console.error(`[worker] reaper: ${removed} export(es) viejo(s) borrado(s) de ${opts.exportDir}`)
    }
  }
}
