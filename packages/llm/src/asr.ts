import { DASHSCOPE_BASE_URL, type LlmEnv } from './llm.js'

/**
 * Transcripción de audio a texto. La precedencia de proveedores es la del
 * plan: LOCAL_ASR_BASE_URL (solo con LLM_PROVIDER=local) → DASHSCOPE_API_KEY
 * (qwen3-asr-flash) → OPENAI_API_KEY (whisper-1) → null (error claro).
 *
 * Rutas verificadas contra los servidores reales:
 * - whisper.cpp (brew, ggml 0.17): POST {baseUrl}/inference con multipart
 *   file + response_format + language. El campo model se ignora sin error.
 *   NO expone /audio/transcriptions pese a lo que dice la doc del plan.
 * - DashScope intl y OpenAI: POST {baseUrl}/audio/transcriptions (contrato
 *   OpenAI multipart; DashScope pendiente de probar con key real).
 */

export interface TranscriptionConfig {
  provider: 'local' | 'dashscope' | 'openai'
  baseUrl: string
  /** whisper.cpp: /inference. DashScope y OpenAI: /audio/transcriptions. */
  path: string
  model: string
  apiKey?: string
}

export interface TranscriptionEnv extends LlmEnv {
  LOCAL_ASR_BASE_URL?: string
  LOCAL_ASR_MODEL?: string
  DASHSCOPE_API_KEY?: string
  OPENAI_API_KEY?: string
}

const LOCAL_DEFAULT_ASR_MODEL = 'large-v3-turbo'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

export function getTranscriptionConfig(env: TranscriptionEnv = process.env): TranscriptionConfig | null {
  const providerIsLocal = env.LLM_PROVIDER !== 'dashscope'
  if (providerIsLocal && env.LOCAL_ASR_BASE_URL) {
    return {
      provider: 'local',
      baseUrl: env.LOCAL_ASR_BASE_URL.replace(/\/+$/, ''),
      path: '/inference',
      model: env.LOCAL_ASR_MODEL || LOCAL_DEFAULT_ASR_MODEL,
    }
  }
  if (env.DASHSCOPE_API_KEY) {
    return {
      provider: 'dashscope',
      baseUrl: DASHSCOPE_BASE_URL,
      path: '/audio/transcriptions',
      model: 'qwen3-asr-flash',
      apiKey: env.DASHSCOPE_API_KEY,
    }
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      baseUrl: OPENAI_BASE_URL,
      path: '/audio/transcriptions',
      model: 'whisper-1',
      apiKey: env.OPENAI_API_KEY,
    }
  }
  return null
}

/** WhatsApp manda ogg/opus; el resto cubre los medios que Evolution puede devolver. */
const MIME_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/amr': 'amr',
  'audio/amr-wb': 'amr',
  'audio/3gpp': '3gpp',
  'audio/3gpp2': '3gpp',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

export function extensionFor(mimetype: string | null | undefined): string {
  const base = (mimetype ?? '').split(';')[0]!.trim().toLowerCase()
  // desconocido → bin genérico: el servidor decide si lo acepta
  return MIME_EXT[base] ?? 'bin'
}

export interface TranscribeAudioInput {
  base64: string
  mimetype?: string | null
}

export interface TranscribeOptions {
  fetch?: typeof fetch
  /** Idioma del audio; los audios de esta plataforma son en español. */
  language?: string
  timeoutMs?: number
}

const NETWORK_ERROR = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptionError'
  }
}

export async function transcribeAudio(
  input: TranscribeAudioInput,
  config: TranscriptionConfig,
  opts: TranscribeOptions = {},
): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const bytes = Buffer.from(input.base64, 'base64')
  if (bytes.length === 0) {
    throw new TranscriptionError('el audio llega vacío: no hay nada que transcribir')
  }
  const mimetype = (input.mimetype ?? 'audio/ogg; codecs=opus').trim()
  const form = new FormData()
  form.append('file', new File([bytes], `audio.${extensionFor(mimetype)}`, { type: mimetype }))
  form.append('model', config.model)
  form.append('response_format', 'json')
  form.append('language', opts.language ?? 'es')

  const url = `${config.baseUrl}${config.path}`
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        // whisper.cpp no pide key; DashScope y OpenAI sí
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new TranscriptionError(`el ASR ${config.provider} no respondió en ${opts.timeoutMs ?? 120_000} ms`)
    }
    if (NETWORK_ERROR.test(detail)) {
      throw new TranscriptionError(`no se pudo alcanzar el ASR ${config.provider} en ${config.baseUrl}: ${detail}`)
    }
    throw new TranscriptionError(`fallo llamando al ASR ${config.provider}: ${detail}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new TranscriptionError(
      `el ASR ${config.provider} respondió HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    )
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new TranscriptionError(`el ASR ${config.provider} devolvió una respuesta que no es JSON`)
  }
  const text = (json as { text?: unknown } | null)?.text
  if (typeof text !== 'string') {
    throw new TranscriptionError(`la respuesta del ASR ${config.provider} no trae texto`)
  }
  return text.trim()
}
