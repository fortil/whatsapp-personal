import { and, eq, ne } from 'drizzle-orm'
import { UnrecoverableError } from 'bullmq'
import { getDb, messages, waInstances, type Db } from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import { getTranscriptionConfig, transcribeAudio, type TranscriptionConfig } from '@wp/llm'

/**
 * Job transcribe: baja el audio por getBase64FromMediaMessage (base64 dentro
 * de JSON, por eso vive en el worker y no en la API), lo transcribe y guarda
 * el texto. Los reintentos los hace BullMQ; lo que falla sin remedio se marca
 * UnrecoverableError para no quemar los 3 intentos.
 */

export interface TranscribeDeps {
  db?: Db
  /** Cliente de Evolution; null cuando falta la configuración. */
  evolution?: EvolutionClient | null
  /** Inyectable para tests; por defecto el del env. */
  transcriptionConfig?: TranscriptionConfig | null
  /** Inyectable para tests; por defecto transcribeAudio real. */
  transcribe?: typeof transcribeAudio
}

/** Respuesta de Evolution: el base64 llega arriba o envuelto en response. */
export function mediaFromEvolution(payload: unknown): { base64: string; mimetype: string | null } {
  const root = (payload ?? {}) as Record<string, unknown>
  const inner = (root.response && typeof root.response === 'object' ? root.response : root) as Record<string, unknown>
  const base64 = typeof inner.base64 === 'string' ? inner.base64 : null
  const mimetype = typeof inner.mimetype === 'string' ? inner.mimetype : null
  if (!base64) {
    throw new Error(
      `Evolution no devolvió base64 para el audio (keys: ${Object.keys(inner).join(', ') || 'vacío'})`,
    )
  }
  return { base64, mimetype }
}

export async function runTranscribe(messageId: string, deps: TranscribeDeps = {}): Promise<'done' | 'skipped'> {
  const db = deps.db ?? getDb()
  const msg = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]
  if (!msg) throw new UnrecoverableError(`el mensaje ${messageId} no existe`)
  // idempotente: un reintento (o un doble encolado) después del éxito no repite trabajo
  if (msg.transcriptStatus === 'done') return 'skipped'
  if (msg.type !== 'audio') throw new UnrecoverableError('el mensaje no es un audio')
  if (!msg.externalId) {
    throw new UnrecoverableError('el mensaje no tiene external_id: no hay forma de pedirle el audio a WhatsApp')
  }

  const config = deps.transcriptionConfig !== undefined ? deps.transcriptionConfig : getTranscriptionConfig()
  if (!config) {
    throw new UnrecoverableError(
      'no hay proveedor de transcripción configurado (LOCAL_ASR_BASE_URL, DASHSCOPE_API_KEY u OPENAI_API_KEY)',
    )
  }

  const instance = (await db.select().from(waInstances).where(eq(waInstances.userId, msg.userId)).limit(1))[0]
  const evolution = deps.evolution ?? null
  if (!instance || !evolution) {
    throw new UnrecoverableError('el usuario no tiene instancia de WhatsApp vinculada')
  }

  const media = mediaFromEvolution(await evolution.getMediaBase64(instance.instanceName, msg.externalId))
  const text = await (deps.transcribe ?? transcribeAudio)(
    { base64: media.base64, mimetype: msg.mediaMime ?? media.mimetype },
    config,
  )

  await db
    .update(messages)
    .set({
      transcript: text,
      transcriptStatus: 'done',
      transcriptModel: config.model,
      transcribedAt: new Date(),
    })
    .where(eq(messages.id, messageId))
  return 'done'
}

/** Lo llama el handler de 'failed' cuando el job agotó sus intentos. */
export async function markTranscriptError(db: Db, messageId: string, reason: string): Promise<void> {
  // sin columna de error en messages: el detalle vive en el log del worker y
  // el estado 'error' habilita el botón Reintentar del panel. Filtra por
  // <> 'done': un job duplicado que agota intentos después de que otro ya
  // dejó el mensaje transcrito no debe pisar un resultado bueno.
  await db
    .update(messages)
    .set({ transcriptStatus: 'error' })
    .where(and(eq(messages.id, messageId), ne(messages.transcriptStatus, 'done')))
  console.error(`[worker] transcribe de ${messageId} falló definitivamente: ${reason}`)
}

/**
 * BullMQ ya no reintenta un job cuando: falló con UnrecoverableError, o
 * agotó los intentos configurados al encolar. Pura para poder probarla sin
 * un Job real de BullMQ.
 */
export function isTranscribeJobExhausted(err: Error, attemptsMade: number, maxAttempts: number): boolean {
  return err instanceof UnrecoverableError || attemptsMade >= maxAttempts
}

/** Job mínimo que necesita el handler de 'failed'; evita acoplarse al tipo Job de bullmq en el test. */
export interface FailedJobInfo {
  name: string
  data: unknown
  attemptsMade: number
  opts?: { attempts?: number }
}

/**
 * Handler de 'failed' del worker para el job transcribe: si BullMQ agotó los
 * intentos (o el fallo es UnrecoverableError), marca el mensaje en error.
 * Jobs de otro tipo, o sin messageId en el payload, no tocan nada.
 */
export async function handleTranscribeFailure(db: Db, job: FailedJobInfo | undefined, err: Error): Promise<void> {
  if (!job || job.name !== 'transcribe') return
  if (!isTranscribeJobExhausted(err, job.attemptsMade, job.opts?.attempts ?? 1)) return
  const messageId = (job.data as { messageId?: string }).messageId
  if (!messageId) return
  await markTranscriptError(db, messageId, err.message)
}
