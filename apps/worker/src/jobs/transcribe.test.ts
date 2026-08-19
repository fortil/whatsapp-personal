import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { eq, inArray } from 'drizzle-orm'
import {
  closeClient,
  contacts,
  conversations,
  getDb,
  messages,
  users,
  waInstances,
  type Db,
} from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import type { TranscriptionConfig } from '@wp/llm'
import {
  handleTranscribeFailure,
  isTranscribeJobExhausted,
  markTranscriptError,
  mediaFromEvolution,
  runTranscribe,
} from './transcribe.js'

/**
 * runTranscribe con dependencias inyectadas: nada de esto llama a Evolution
 * ni al ASR reales. La transcripción de verdad contra whisper.cpp se prueba
 * aparte (packages/llm) y se documenta en el reporte de ejecución.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`

let db: Db
let userId: string
let conversationId: string
let audioMsgId: string
let happyPathMsgId: string
let textMsgId: string
let doneMsgId: string
const suiteUserIds: string[] = []

function fakeEvolution(base64: string, mimetype: string | null): EvolutionClient {
  return {
    async createInstance() {},
    async setWebhook() {},
    async connectionState() {
      return 'connected'
    },
    async connect() {
      return { base64: null, code: null }
    },
    async logout() {},
    async deleteInstance() {},
    async sendText() {
      return { messageId: null }
    },
    async sendPresence() {},
    async getMediaBase64() {
      return { base64, mimetype }
    },
    async findContacts() {
      return []
    },
    async findChats() {
      return []
    },
  }
}

const localConfig: TranscriptionConfig = {
  provider: 'local',
  baseUrl: 'http://asr.test',
  path: '/inference',
  model: 'large-v3-turbo',
}

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-transcribe.${RUN}@mail.test`,
      phone: `+57300${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)

  await db.insert(waInstances).values({ userId, instanceName: `u_${RUN}`, state: 'connected' })

  const [contact] = await db
    .insert(contacts)
    .values({ userId, waJid: '573001112233@s.whatsapp.net', displayName: 'Prueba worker' })
    .returning()
  const [conv] = await db
    .insert(conversations)
    .values({ userId, contactId: contact!.id, waJid: contact!.waJid, lastMessageAt: new Date() })
    .returning()
  conversationId = conv!.id

  const [audio] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-AUDIO-${RUN}`,
      direction: 'in',
      type: 'audio',
      mediaMime: 'audio/ogg; codecs=opus',
      transcriptStatus: 'pending',
      transcribeStartedAt: new Date(),
      sentAt: new Date(),
    })
    .returning()
  audioMsgId = audio!.id

  // fila propia para el camino feliz: no comparte estado con audioMsgId, así
  // que los tests que exigen que ese otro mensaje siga 'pending' no dependen
  // de correr antes que este (N11 de la revisión)
  const [happyPath] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-HAPPY-${RUN}`,
      direction: 'in',
      type: 'audio',
      mediaMime: 'audio/ogg; codecs=opus',
      transcriptStatus: 'pending',
      transcribeStartedAt: new Date(),
      sentAt: new Date(),
    })
    .returning()
  happyPathMsgId = happyPath!.id

  const [text] = await db
    .insert(messages)
    .values({ conversationId, userId, externalId: `EXT-TEXT-${RUN}`, direction: 'in', type: 'text', body: 'hola', sentAt: new Date() })
    .returning()
  textMsgId = text!.id

  const [done] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-DONE-${RUN}`,
      direction: 'in',
      type: 'audio',
      transcript: 'ya transcrito antes',
      transcriptStatus: 'done',
      sentAt: new Date(),
    })
    .returning()
  doneMsgId = done!.id
})

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.userId, suiteUserIds)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(waInstances).where(inArray(waInstances.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

describe('mediaFromEvolution', () => {
  it('lee base64/mimetype en la raíz de la respuesta', () => {
    expect(mediaFromEvolution({ base64: 'QUJD', mimetype: 'audio/ogg' })).toEqual({
      base64: 'QUJD',
      mimetype: 'audio/ogg',
    })
  })

  it('lee base64/mimetype envueltos en response', () => {
    expect(mediaFromEvolution({ response: { base64: 'QUJD', mimetype: null } })).toEqual({
      base64: 'QUJD',
      mimetype: null,
    })
  })

  it('sin base64: error legible con las keys que sí llegaron', () => {
    expect(() => mediaFromEvolution({ otraCosa: 1 })).toThrow('Evolution no devolvió base64')
  })
})

describe('runTranscribe', () => {
  it('mensaje inexistente: UnrecoverableError', async () => {
    await expect(
      runTranscribe('00000000-0000-0000-0000-000000000000', { db }),
    ).rejects.toThrow(UnrecoverableError)
  })

  it('ya done: idempotente, no llama a nadie', async () => {
    let called = false
    const result = await runTranscribe(doneMsgId, {
      db,
      evolution: fakeEvolution('x', 'audio/ogg'),
      transcriptionConfig: localConfig,
      transcribe: async () => {
        called = true
        return 'no debería llegar aquí'
      },
    })
    expect(result).toBe('skipped')
    expect(called).toBe(false)
  })

  it('mensaje que no es audio: UnrecoverableError', async () => {
    await expect(runTranscribe(textMsgId, { db })).rejects.toThrow(UnrecoverableError)
  })

  it('sin proveedor de transcripción configurado: UnrecoverableError', async () => {
    await expect(
      runTranscribe(audioMsgId, { db, transcriptionConfig: null }),
    ).rejects.toThrow(/no hay proveedor de transcripción/)
  })

  it('sin instancia o sin evolution: UnrecoverableError', async () => {
    await expect(
      runTranscribe(audioMsgId, { db, transcriptionConfig: localConfig, evolution: null }),
    ).rejects.toThrow(/no tiene instancia de WhatsApp/)
  })

  it('camino feliz: baja el audio, transcribe y guarda done', async () => {
    const audioBytes = Buffer.from('audio-falso').toString('base64')
    let seenInput: { base64: string; mimetype?: string | null } | undefined
    const result = await runTranscribe(happyPathMsgId, {
      db,
      evolution: fakeEvolution(audioBytes, 'audio/ogg; codecs=opus'),
      transcriptionConfig: localConfig,
      transcribe: async (input) => {
        seenInput = input
        return '  hola desde el worker  '
      },
    })
    expect(result).toBe('done')
    expect(seenInput?.base64).toBe(audioBytes)

    const row = (await db.select().from(messages).where(eq(messages.id, happyPathMsgId)).limit(1))[0]!
    expect(row.transcript).toBe('  hola desde el worker  ')
    expect(row.transcriptStatus).toBe('done')
    expect(row.transcriptModel).toBe('large-v3-turbo')
    expect(row.transcribedAt).not.toBeNull()
  })
})

describe('isTranscribeJobExhausted', () => {
  it('UnrecoverableError: agotado sin importar attemptsMade', () => {
    expect(isTranscribeJobExhausted(new UnrecoverableError('boom'), 1, 3)).toBe(true)
  })

  it('attemptsMade 1 de 3: todavía no agotado', () => {
    expect(isTranscribeJobExhausted(new Error('red caída'), 1, 3)).toBe(false)
  })

  it('attemptsMade 2 de 3: todavía no agotado', () => {
    expect(isTranscribeJobExhausted(new Error('red caída'), 2, 3)).toBe(false)
  })

  it('attemptsMade 3 de 3: agotado', () => {
    expect(isTranscribeJobExhausted(new Error('red caída'), 3, 3)).toBe(true)
  })
})

describe('handleTranscribeFailure', () => {
  it('job de otro tipo: no toca el mensaje', async () => {
    await db.update(messages).set({ transcriptStatus: 'pending' }).where(eq(messages.id, textMsgId))
    await handleTranscribeFailure(
      db,
      { name: 'summarize', data: { messageId: textMsgId }, attemptsMade: 3, opts: { attempts: 3 } },
      new Error('boom'),
    )
    const row = (await db.select().from(messages).where(eq(messages.id, textMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('pending')
  })

  it('transcribe sin agotar intentos: no marca error todavía', async () => {
    await db.update(messages).set({ transcriptStatus: 'pending' }).where(eq(messages.id, textMsgId))
    await handleTranscribeFailure(
      db,
      { name: 'transcribe', data: { messageId: textMsgId }, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('red caída'),
    )
    const row = (await db.select().from(messages).where(eq(messages.id, textMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('pending')
  })

  it('transcribe con intentos agotados: marca error', async () => {
    await db.update(messages).set({ transcriptStatus: 'pending' }).where(eq(messages.id, textMsgId))
    await handleTranscribeFailure(
      db,
      { name: 'transcribe', data: { messageId: textMsgId }, attemptsMade: 3, opts: { attempts: 3 } },
      new Error('red caída'),
    )
    const row = (await db.select().from(messages).where(eq(messages.id, textMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('error')
  })
})

describe('markTranscriptError', () => {
  it('deja el mensaje en error, reintentable desde el panel', async () => {
    await db.update(messages).set({ transcriptStatus: 'pending' }).where(eq(messages.id, textMsgId))
    await markTranscriptError(db, textMsgId, 'boom')
    const row = (await db.select().from(messages).where(eq(messages.id, textMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('error')
  })

  it('mensaje ya done: un job duplicado tardío no le pisa el resultado bueno', async () => {
    await db.update(messages).set({ transcriptStatus: 'done' }).where(eq(messages.id, textMsgId))
    await markTranscriptError(db, textMsgId, 'boom tardío')
    const row = (await db.select().from(messages).where(eq(messages.id, textMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('done')
  })
})
