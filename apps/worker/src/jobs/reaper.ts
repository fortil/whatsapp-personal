import { and, eq, lt } from 'drizzle-orm'
import { messages, type Db } from '@wp/db'

/**
 * Reaper mínimo de esta fase: barre transcripciones 'pending' colgadas más de
 * `thresholdMs` sin actividad y las marca 'error', reintentables desde el
 * panel. Los otros barridos (task_runs colgados, exports viejos de
 * EXPORT_DIR) son de la Fase 4; este archivo es el único punto donde se
 * agregan cuando lleguen. Exportado y con `db` por parámetro para poder
 * probarlo sin arrancar el worker completo (que abre Redis y bindea el
 * puerto de health).
 */

export const DEFAULT_STUCK_TRANSCRIPTION_THRESHOLD_MS = 10 * 60_000

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

/** Un ciclo del barrido, con el log que espera el operador del worker. */
export async function runReaperSweep(db: Db): Promise<void> {
  const stuck = await sweepStuckTranscriptions(db)
  if (stuck > 0) {
    console.error(`[worker] reaper: ${stuck} transcripción(es) colgada(s) marcada(s) como error`)
  }
}
