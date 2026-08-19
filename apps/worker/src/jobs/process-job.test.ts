import { describe, expect, it } from 'vitest'
import { UnrecoverableError, type Job } from 'bullmq'
import { getDb, type Db } from '@wp/db'
import { processJob } from './process-job.js'

/**
 * La rama `default` (job desconocido) y el cableado hacia `runTranscribe`
 * vivían inline en index.ts, un módulo que al importarse abre Redis y
 * bindea el puerto de health. processJob no depende de nada de eso.
 */

const db: Db = getDb()

function fakeJob(name: string, data: unknown): Job {
  return { name, data } as unknown as Job
}

describe('processJob', () => {
  it('nombre de job desconocido: UnrecoverableError, no se reintenta', async () => {
    await expect(processJob(fakeJob('summarize', {}), { db, evolution: null })).rejects.toThrow(
      UnrecoverableError,
    )
  })

  it('transcribe: delega en runTranscribe con el messageId del payload', async () => {
    // mensaje inexistente: runTranscribe también lanza UnrecoverableError,
    // suficiente para probar que processJob llega a llamarlo con los deps
    await expect(
      processJob(fakeJob('transcribe', { messageId: '00000000-0000-0000-0000-000000000000' }), {
        db,
        evolution: null,
      }),
    ).rejects.toThrow(/no existe/)
  })
})
