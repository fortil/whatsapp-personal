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

/**
 * Marca 'error' los mensajes 'pending' con `transcribeStartedAt` viejo. Devuelve cuántos tocó.
 * `conversationId` es para los tests: restringe el barrido a una conversación
 * para no tocar filas de otra suite que comparta la DB (el UPDATE de por sí
 * barre la tabla entera); en producción no se pasa y queda igual que siempre.
 */
export async function sweepStuckTranscriptions(
  db: Db,
  thresholdMs: number = DEFAULT_STUCK_TRANSCRIPTION_THRESHOLD_MS,
  conversationId?: string,
): Promise<number> {
  const threshold = new Date(Date.now() - thresholdMs)
  const stuck = await db
    .update(messages)
    .set({ transcriptStatus: 'error' })
    .where(
      and(
        eq(messages.transcriptStatus, 'pending'),
        lt(messages.transcribeStartedAt, threshold),
        ...(conversationId ? [eq(messages.conversationId, conversationId)] : []),
      ),
    )
    .returning({ id: messages.id })
  return stuck.length
}

/**
 * task_runs 'running' estancados (updated_at viejo) cuyo job de BullMQ ya no
 * está activo quedan en error "interrumpido": la barra del panel no puede
 * quedarse girando para siempre sobre un job que murió con el worker.
 * isActiveJob la cablea index.ts contra BullMQ; sin ella se decide solo por
 * reloj (el worker corre a concurrencia 1).
 * `userId` es para los tests, igual que `conversationId` arriba: restringe el
 * barrido a las filas de una suite para no tocar task_runs de otra que
 * comparta la DB; en producción no se pasa y queda igual que siempre.
 */
export async function sweepStuckTaskRuns(
  db: Db,
  thresholdMs: number = DEFAULT_STUCK_TASK_THRESHOLD_MS,
  isActiveJob: (bullmqJobId: string) => Promise<boolean> = async () => false,
  userId?: string,
): Promise<number> {
  const threshold = new Date(Date.now() - thresholdMs)
  const candidates = await db
    .select({ id: taskRuns.id, bullmqJobId: taskRuns.bullmqJobId })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.status, 'running'),
        lt(taskRuns.updatedAt, threshold),
        ...(userId ? [eq(taskRuns.userId, userId)] : []),
      ),
    )

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
 * archivos que ya no existen (disco limpiado a mano). Un fallo de stat que
 * NO sea "no existe" (permisos, disco caído) deja la fila como estaba: tratar
 * cualquier error como archivo inexistente dejaba huérfano un archivo que
 * solo estaba inaccesible ese ciclo.
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
    let clearPath = false
    try {
      const info = await stat(row.filePath)
      if (info.mtimeMs >= cutoff) continue // aún vigente: ni borrar ni limpiar
      await unlink(row.filePath)
      removed += 1
      clearPath = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // el archivo ya no existe: la fila no debe seguir ofreciendo una
        // descarga rota, se limpia igual
        clearPath = true
      } else {
        // inaccesible, no inexistente: la fila queda intacta y el próximo
        // ciclo lo reintenta, pero que quede el rastro en el log
        console.error(
          `[worker] reaper: no se pudo revisar ${row.filePath} (${(err as NodeJS.ErrnoException).code ?? 'sin código'}): se reintenta en el próximo ciclo`,
        )
        continue
      }
    }
    if (clearPath) {
      await db.update(taskRuns).set({ filePath: null, updatedAt: new Date() }).where(eq(taskRuns.id, row.id))
    }
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
