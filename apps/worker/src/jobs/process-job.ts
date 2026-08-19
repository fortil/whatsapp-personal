import { UnrecoverableError, type Job } from 'bullmq'
import type { Db } from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import type { LlmClient } from '@wp/llm'
import { runTranscribe } from './transcribe.js'
import { runContactsSync } from './contacts-sync.js'
import { runSummarize, type SummarizeJobPayload } from './summarize.js'
import { runContactsExport } from './contacts-export.js'

/**
 * Dispatcher de jobs BullMQ del worker. Exportado y con dependencias por
 * parámetro (no lee `process.env` ni abre conexiones) para poder probarlo
 * sin arrancar el worker completo. birthday_* llega en la Fase 5; un nombre
 * desconocido hoy es un bug de encolado, no un fallo transitorio, así que
 * no vale la pena reintentarlo.
 */

export interface ProcessJobDeps {
  db: Db
  evolution: EvolutionClient | null
  /** Dónde caen los xlsx del export; index.ts lo pasa desde el env. */
  exportDir?: string
  /** Cliente LLM inyectable para tests; por defecto el que construye cada job. */
  llm?: LlmClient
}

export async function processJob(job: Job, deps: ProcessJobDeps): Promise<unknown> {
  switch (job.name) {
    case 'transcribe': {
      const { messageId } = job.data as { messageId: string }
      return runTranscribe(messageId, deps)
    }
    case 'contacts_sync': {
      const { userId, taskRunId } = job.data as { userId: string; taskRunId?: string }
      return runContactsSync(userId, taskRunId ?? null, deps)
    }
    case 'summarize': {
      const payload = job.data as SummarizeJobPayload
      return runSummarize(payload, deps)
    }
    case 'contacts_export': {
      const { userId, taskRunId, includeSummaries } = job.data as {
        userId: string
        taskRunId: string
        includeSummaries?: boolean
      }
      return runContactsExport(userId, taskRunId, includeSummaries ?? false, deps)
    }
    default:
      throw new UnrecoverableError(`job desconocido: ${job.name}`)
  }
}
