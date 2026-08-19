import { describe, expect, it } from 'vitest'
import { UnrecoverableError, type Job } from 'bullmq'
import { getDb, type Db } from '@wp/db'
import { processJob } from './process-job.js'

/**
 * La rama `default` (job desconocido) y el cableado hacia cada runner (que
 * viven inline en index.ts, un módulo que al importarse abre Redis y bindea
 * el puerto de health) se prueban aquí sin ninguno de esos efectos.
 */

const db: Db = getDb()

function fakeJob(name: string, data: unknown): Job {
  return { name, data } as unknown as Job
}

describe('processJob', () => {
  it('nombre de job desconocido: UnrecoverableError, no se reintenta', async () => {
    // birthday_import es real en el plan pero llega en la Fase 5: hoy es
    // tan desconocido para el dispatcher como cualquier typo
    await expect(processJob(fakeJob('birthday_import', {}), { db, evolution: null })).rejects.toThrow(
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

  it('contacts_sync: delega en runContactsSync con el userId del payload', async () => {
    // usuario inexistente: runContactsSync lanza por falta de instancia, lo
    // que basta para probar que processJob llegó a llamarlo con los deps
    await expect(
      processJob(fakeJob('contacts_sync', { userId: '00000000-0000-0000-0000-000000000000' }), {
        db,
        evolution: null,
      }),
    ).rejects.toThrow(/no tiene instancia de WhatsApp/)
  })

  it('summarize: delega en runSummarize con el payload completo', async () => {
    // conversación inexistente: summarizeConversation lanza, suficiente
    // para probar el cableado sin depender de un LLM real
    await expect(
      processJob(
        fakeJob('summarize', { userId: '00000000-0000-0000-0000-000000000000', conversationId: '00000000-0000-0000-0000-000000000000' }),
        { db, evolution: null },
      ),
    ).rejects.toThrow(/no existe para este usuario/)
  })
})
