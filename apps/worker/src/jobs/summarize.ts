import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { getDb, conversations, messages, taskRuns, waInstances, type Db } from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import { computeCostUsd, createLlmClient, type LlmClient } from '@wp/llm'

/**
 * Job summarize: resumen de una conversación, DB-first. El watermark es
 * summary_thru_created_at (reloj de inserción de la DB): un mensaje que llega
 * tarde con sent_at viejo igual tiene created_at nuevo y entra al siguiente
 * resumen. Tope de entrada ~12k tokens porque Ollama trunca el prompt en
 * silencio y el resumen saldría sobre media conversación.
 */

export const MAX_BODY_CHARS = 500
export const COLD_START_MAX_MESSAGES = 200
export const COLD_START_WINDOW_DAYS = 30
/** Umbral incremental: con menos mensajes nuevos que esto no se re-resume. */
export const NEW_MESSAGES_THRESHOLD = 20
export const INPUT_TOKEN_CAP = 12_000
/** Estimación conservadora para español; sirve para el tope, no para facturar. */
export const CHARS_PER_TOKEN = 4
/** Arranque en frío vía findMessages: la paginación de Evolution no es confiable. */
export const COLD_START_FETCH_PAGES = 5
export const COLD_START_PAGE_SIZE = 50

export type SummaryStatus = 'done' | 'skipped-empty' | 'skipped-threshold'

export interface SummarizeResult {
  status: SummaryStatus
  summary: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  passes: number
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Una línea del transcript: cuerpo truncado; el audio entra como [audio] o su transcript. */
export function renderMessage(row: {
  direction: 'in' | 'out'
  type: string
  body: string | null
  transcript: string | null
}): string {
  const who = row.direction === 'out' ? 'Yo' : 'Contacto'
  let text: string
  if (row.type === 'audio') {
    text = row.transcript?.trim() ? row.transcript.trim() : '[audio]'
  } else {
    text = row.body?.trim() ? row.body.trim() : `[${row.type}]`
  }
  if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS)}…`
  return `${who}: ${text}`
}

function renderTranscript(rows: Array<typeof messages.$inferSelect>): string {
  return rows.map(renderMessage).join('\n')
}

const SUMMARY_SYSTEM =
  'Resumes conversaciones de WhatsApp en español. La transcripción usa el prefijo ' +
  '"Yo:" para el dueño del número y "Contacto:" para la otra persona. Escribe un resumen ' +
  'en prosa de 3 a 6 oraciones: de qué hablaron, acuerdos, pendientes y fechas que se ' +
  'mencionen. No inventes nada que no esté en la conversación y no uses listas.'

const SUMMARY_SYSTEM_PARTIAL =
  'Resumes fragmentos de una conversación de WhatsApp en español. La transcripción usa ' +
  'el prefijo "Yo:" para el dueño del número y "Contacto:" para la otra persona. Escribe ' +
  'un resumen parcial de 2 o 3 oraciones con lo esencial del fragmento, en prosa y sin listas.'

async function generate(
  llm: LlmClient,
  system: string,
  prompt: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<string> {
  const res = await llm.generate({ system, prompt })
  usage.inputTokens += res.inputTokens
  usage.outputTokens += res.outputTokens
  return res.text
}

/**
 * Transcript que excede el tope: se recortan las líneas más viejas primero
 * (las nuevas son las que el resumen incremental necesita). Devuelve el
 * transcript recortado y cuántas líneas cayeron.
 */
export function trimOldestLines(transcript: string, tokenCap: number = INPUT_TOKEN_CAP): { text: string; dropped: number } {
  const lines = transcript.split('\n')
  let kept = lines.length
  while (kept > 0 && estimateTokens(lines.slice(lines.length - kept).join('\n')) > tokenCap) {
    kept -= 1
  }
  return { text: lines.slice(lines.length - kept).join('\n'), dropped: lines.length - kept }
}

/**
 * Map-reduce en dos pasadas: pasadas de map sobre fragmentos consecutivos
 * (cada uno bajo el tope) y una pasada final que los integra. Así la
 * conversación completa entra al resumen aunque no quepa en un solo prompt.
 */
export function splitUnderCap(transcript: string, tokenCap: number = INPUT_TOKEN_CAP): string[] {
  const lines = transcript.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  for (const line of lines) {
    // una línea sola jamás excede (body ≤ 500 chars ≈ 125 tokens), así que
    // agregarla a un chunk vacío siempre cabe
    if (current.length > 0 && estimateTokens([...current, line].join('\n')) > tokenCap) {
      chunks.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks
}

// ---------- arranque en frío vía findMessages ----------

/** findMessages devuelve el arreglo en niveles distintos según la versión de Evolution. */
export function extractHistoryMessages(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>
    if (Array.isArray(root.messages)) {
      const inner = root.messages
      if (Array.isArray(inner)) {
        // { messages: [...] } o { messages: { messages: [...] } } (envoltura Baileys)
        return Array.isArray((inner as Record<string, unknown>[])[0]?.messages)
          ? (inner as Record<string, unknown>[]).flatMap((m) =>
              Array.isArray(m.messages) ? (m.messages as unknown[]) : [],
            )
          : inner
      }
    }
    if (root.response && typeof root.response === 'object') return extractHistoryMessages(root.response)
  }
  return []
}

/** Entrada de historial de Baileys → fila de messages; null cuando no aporta texto. */
export function historyMessageRow(entry: unknown): {
  externalId: string | null
  direction: 'in' | 'out'
  type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'other'
  body: string | null
  sentAt: Date
} | null {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const key = record.key && typeof record.key === 'object' ? (record.key as Record<string, unknown>) : {}
  const id = typeof key.id === 'string' && key.id ? key.id : null
  const fromMe = key.fromMe === true
  const content = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : {}
  const contentTypes = Object.keys(content)
  const typeMap: Array<[string, 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'other']> = [
    ['conversation', 'text'],
    ['extendedTextMessage', 'text'],
    ['audioMessage', 'audio'],
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['documentMessage', 'document'],
    ['stickerMessage', 'sticker'],
  ]
  const mapped = typeMap.find(([k]) => contentTypes.includes(k))
  const body =
    typeof content.conversation === 'string'
      ? content.conversation
      : content.extendedTextMessage && typeof (content.extendedTextMessage as Record<string, unknown>).text === 'string'
        ? ((content.extendedTextMessage as Record<string, unknown>).text as string)
        : null
  if (!mapped && !body) return null
  const ts = Number(record.messageTimestamp)
  return {
    externalId: id,
    direction: fromMe ? 'out' : 'in',
    type: mapped ? mapped[1] : 'text',
    body,
    sentAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
  }
}

/**
 * Arranque en frío: la conversación no tiene mensajes en la DB (historial
 * previo a la vinculación) y se piden a Evolution. Tolerante a fallo por
 * diseño: si findMessages no responde lo esperado, se resume con lo que
 * haya. Máximo COLD_START_FETCH_PAGES páginas; se corta en cuanto una
 * página no aporta mensajes nuevos.
 */
async function coldStartHistory(
  db: Db,
  userId: string,
  conversation: typeof conversations.$inferSelect,
  deps: { evolution: EvolutionClient | null },
): Promise<number> {
  const instance = (
    await db.select().from(waInstances).where(eq(waInstances.userId, userId)).limit(1)
  )[0]
  if (!instance || !deps.evolution) return 0
  let insertedTotal = 0
  try {
    for (let page = 0; page < COLD_START_FETCH_PAGES; page += 1) {
      const entries = extractHistoryMessages(
        await deps.evolution.findMessages(instance.instanceName, {
          remoteJid: conversation.waJid,
          page,
          count: COLD_START_PAGE_SIZE,
        }),
      )
      const rows = entries.map(historyMessageRow).filter((r): r is NonNullable<typeof r> => r !== null)
      if (rows.length === 0) break
      const inserted = await db
        .insert(messages)
        .values(
          rows.map((row) => ({
            conversationId: conversation.id,
            userId,
            externalId: row.externalId,
            direction: row.direction,
            type: row.type,
            body: row.body,
            sentAt: row.sentAt,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: messages.id })
      insertedTotal += inserted.length
      if (inserted.length === 0) break
    }
  } catch (err) {
    // la paginación de findMessages no está validada contra una instancia
    // real (riesgo 5): cualquier fallo deja el resumen con lo que ya había
    console.error(
      `[summarize] findMessages falló para ${conversation.waJid} (se continúa con la DB):`,
      err instanceof Error ? err.message : err,
    )
  }
  return insertedTotal
}

// ---------- núcleo ----------

export interface SummarizeCoreDeps {
  db?: Db
  evolution?: EvolutionClient | null
  /** Inyectable para tests; por defecto el cliente del env. */
  llm?: LlmClient
  /** Tope de tokens inyectable para tests. */
  tokenCap?: number
}

export interface SummarizeCoreOptions {
  /** Pisa el umbral incremental: lo usa el botón de resumen del panel. */
  force?: boolean
}

/** Núcleo compartido por el job summarize y el export con includeSummaries. */
export async function summarizeConversation(
  userId: string,
  conversationId: string,
  opts: SummarizeCoreOptions = {},
  deps: SummarizeCoreDeps = {},
): Promise<SummarizeResult> {
  const db = deps.db ?? getDb()
  const llm = deps.llm ?? createLlmClient()
  const tokenCap = deps.tokenCap ?? INPUT_TOKEN_CAP

  const conversation = (
    await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1)
  )[0]
  if (!conversation) throw new Error(`la conversación ${conversationId} no existe para este usuario`)

  const existingCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
  if ((existingCountRows[0]?.count ?? 0) === 0) {
    await coldStartHistory(db, userId, conversation, { evolution: deps.evolution ?? null })
  }

  const windowStart = conversation.summaryThruCreatedAt
  const hasSummary = conversation.summary !== null && conversation.summary.trim() !== ''

  let window: Array<typeof messages.$inferSelect>
  if (windowStart) {
    window = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.createdAt, windowStart)))
      .orderBy(asc(messages.createdAt))
  } else {
    // arranque en frío sin summary previo: los últimos 200 mensajes o 30
    // días, lo que sea menor
    const since = new Date(Date.now() - COLD_START_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const inWindow = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.createdAt, since)))
      .orderBy(desc(messages.createdAt))
      .limit(COLD_START_MAX_MESSAGES)
    window = inWindow.reverse()
  }

  if (window.length === 0) return { status: 'skipped-empty', summary: conversation.summary, inputTokens: 0, outputTokens: 0, costUsd: null, passes: 0 }

  if (hasSummary && !opts.force && window.length < NEW_MESSAGES_THRESHOLD) {
    return { status: 'skipped-threshold', summary: conversation.summary, inputTokens: 0, outputTokens: 0, costUsd: null, passes: 0 }
  }

  const usage = { inputTokens: 0, outputTokens: 0 }
  let passes = 0
  const transcript = renderTranscript(window)

  let summary: string
  if (estimateTokens(transcript) <= tokenCap) {
    const prompt = hasSummary
      ? `Resumen anterior de la conversación:\n${conversation.summary}\n\nMensajes nuevos desde ese resumen:\n${transcript}\n\nEscribe el resumen actualizado.`
      : `Conversación:\n${transcript}\n\nEscribe el resumen.`
    summary = await generate(llm, SUMMARY_SYSTEM, prompt, usage)
    passes = 1
  } else if (hasSummary) {
    // incremental desbordado: el resumen anterior ya cubre lo viejo, se
    // recortan los mensajes más viejos del lote nuevo
    const trimmed = trimOldestLines(transcript, tokenCap)
    if (trimmed.dropped > 0) {
      console.log(`[summarize] lote de ${window.length} mensajes recortado en ${trimmed.dropped} para caber en ${tokenCap} tokens`)
    }
    summary = await generate(
      llm,
      SUMMARY_SYSTEM,
      `Resumen anterior de la conversación:\n${conversation.summary}\n\nMensajes nuevos desde ese resumen (los más recientes):\n${trimmed.text}\n\nEscribe el resumen actualizado.`,
      usage,
    )
    passes = 1
  } else {
    // primera pasada completa que no cabe: map-reduce en dos pasadas
    const chunks = splitUnderCap(transcript, tokenCap)
    const partials: string[] = []
    for (const chunk of chunks) {
      partials.push(await generate(llm, SUMMARY_SYSTEM_PARTIAL, `Fragmento de la conversación:\n${chunk}\n\nEscribe el resumen parcial.`, usage))
    }
    summary = await generate(
      llm,
      SUMMARY_SYSTEM,
      `Resúmenes parciales de la conversación, en orden cronológico:\n\n${partials.join('\n\n')}\n\nEscribe el resumen final que integra los parciales.`,
      usage,
    )
    passes = partials.length + 1
  }

  summary = summary.trim()
  if (!summary) throw new Error('el modelo devolvió un resumen vacío')

  // el watermark avanza hasta el created_at máximo del lote procesado: los
  // mensajes recortados por el tope quedan consumidos (el resumen anterior
  // ya cubría ese contexto). +1ms: Postgres guarda timestamptz con precisión
  // de microsegundos y el driver los trunca a milisegundos al leerlos: sin
  // el margen, la fila que puso el watermark puede "reaparecer" como
  // createdAt > watermark en la siguiente pasada incremental.
  const maxCreatedAt = window.reduce((max, row) => (row.createdAt > max ? row.createdAt : max), window[0]!.createdAt)
  const thru = new Date(maxCreatedAt.getTime() + 1)
  await db
    .update(conversations)
    .set({ summary, summaryModel: llm.config().model, summaryUpdatedAt: new Date(), summaryThruCreatedAt: thru })
    .where(eq(conversations.id, conversationId))

  const config = llm.config()
  return {
    status: 'done',
    summary,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: computeCostUsd(config.provider, config.model, usage),
    passes,
  }
}

export interface SummarizeJobPayload {
  userId: string
  conversationId: string
  taskRunId?: string
  force?: boolean
}

export type SummarizeJobDeps = SummarizeCoreDeps

/** Envoltorio del job BullMQ: actualiza su task_run si el payload lo trae. */
export async function runSummarize(
  payload: SummarizeJobPayload,
  deps: SummarizeJobDeps = {},
): Promise<SummarizeResult> {
  const db = deps.db ?? getDb()
  const taskRunId = payload.taskRunId ?? null
  if (taskRunId) {
    await db
      .update(taskRuns)
      .set({ status: 'running', processed: 0, total: 1, updatedAt: new Date() })
      .where(eq(taskRuns.id, taskRunId))
  }
  try {
    const result = await summarizeConversation(
      payload.userId,
      payload.conversationId,
      { force: payload.force },
      deps,
    )
    if (taskRunId) {
      await db
        .update(taskRuns)
        .set({
          status: 'done',
          processed: 1,
          total: 1,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(taskRuns.id, taskRunId))
    }
    if (result.status === 'done') {
      console.log(
        `[summarize] ${payload.conversationId}: ok en ${result.passes} pasada(s), ` +
          `${result.inputTokens}+${result.outputTokens} tokens, costo ${result.costUsd === null ? 'desconocido' : `$${result.costUsd.toFixed(6)}`}`,
      )
    } else {
      console.log(`[summarize] ${payload.conversationId}: ${result.status}`)
    }
    return result
  } catch (err) {
    if (taskRunId) {
      await db
        .update(taskRuns)
        .set({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(taskRuns.id, taskRunId))
    }
    throw err
  }
}
