import { UnrecoverableError, type Job } from 'bullmq'
import type { Db } from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import { runTranscribe } from './transcribe.js'

/**
 * Dispatcher de jobs BullMQ del worker. Exportado y con dependencias por
 * parámetro (no lee `process.env` ni abre conexiones) para poder probarlo
 * sin arrancar el worker completo. contacts_sync/summarize/contacts_export/
 * birthday_* llegan en fases siguientes; un nombre desconocido hoy es un bug
 * de encolado, no un fallo transitorio, así que no vale la pena reintentarlo.
 */

export interface ProcessJobDeps {
  db: Db
  evolution: EvolutionClient | null
}

export async function processJob(job: Job, deps: ProcessJobDeps): Promise<unknown> {
  switch (job.name) {
    case 'transcribe': {
      const { messageId } = job.data as { messageId: string }
      return runTranscribe(messageId, deps)
    }
    default:
      throw new UnrecoverableError(`job desconocido: ${job.name}`)
  }
}
