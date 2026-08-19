import { generateText, APICallError } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

/**
 * Resolución del proveedor de LLM por env, con el patrón del mailer: nunca
 * lanza al construirse y el env se lee tarde (primera llamada), para que los
 * tests que setean variables después de importar no se rompan.
 */

export type LlmProviderName = 'local' | 'dashscope'

export interface LlmConfig {
  provider: LlmProviderName
  baseUrl: string
  model: string
  apiKey?: string
}

export interface LlmEnv {
  LLM_PROVIDER?: string
  LOCAL_LLM_BASE_URL?: string
  LOCAL_LLM_MODEL?: string
  DASHSCOPE_API_KEY?: string
}

export const DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

const LOCAL_DEFAULT_BASE_URL = 'http://localhost:11434/v1'
const LOCAL_DEFAULT_MODEL = 'qwen3:8b'
const DASHSCOPE_MODEL = 'qwen-flash'

export function resolveLlmConfig(env: LlmEnv = process.env): LlmConfig {
  if (env.LLM_PROVIDER === 'dashscope') {
    return {
      provider: 'dashscope',
      baseUrl: DASHSCOPE_BASE_URL,
      model: DASHSCOPE_MODEL,
      apiKey: env.DASHSCOPE_API_KEY || undefined,
    }
  }
  return {
    provider: 'local',
    baseUrl: (env.LOCAL_LLM_BASE_URL || LOCAL_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.LOCAL_LLM_MODEL || LOCAL_DEFAULT_MODEL,
  }
}

export interface LlmGenerateInput {
  system?: string
  prompt: string
}

export interface LlmGenerateResult {
  text: string
  inputTokens: number
  outputTokens: number
  model: string
}

export interface LlmClient {
  config(): LlmConfig
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>
}

export interface LlmOptions {
  /** Fija la configuración; sin ella se resuelve del env en cada llamada. */
  config?: LlmConfig
  /** Inyectable para tests; default fetch global. */
  fetch?: typeof fetch
}

/** Un proveedor AI SDK por configuración: crearlo por llamada tiraría conexiones. */
const providerCache = new Map<string, ReturnType<typeof createOpenAICompatible>>()

function providerFor(config: LlmConfig, doFetch?: typeof fetch) {
  const key = JSON.stringify(config)
  let provider = providerCache.get(key)
  if (!provider) {
    provider = createOpenAICompatible({
      name: config.provider,
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      fetch: doFetch,
    })
    providerCache.set(key, provider)
  }
  return provider
}

const NETWORK_ERROR = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|terminated/i

/**
 * Un endpoint muerto no debe salir como timeout opaco del SDK. El plan exige
 * el mensaje literal "no se pudo alcanzar el modelo local en {url}".
 */
export function friendlyLlmError(err: unknown, config: LlmConfig): Error {
  const detail = err instanceof Error ? err.message : String(err)
  const apiError = err instanceof APICallError ? err : undefined
  const isNetwork =
    NETWORK_ERROR.test(detail) || (apiError !== undefined && (apiError.statusCode === undefined || apiError.statusCode === 0))
  if (isNetwork) {
    const donde =
      config.provider === 'local'
        ? `el modelo local en ${config.baseUrl}`
        : `el proveedor ${config.provider} en ${config.baseUrl}`
    return new Error(`no se pudo alcanzar ${donde}: ${detail}`)
  }
  return err instanceof Error ? err : new Error(detail)
}

export function createLlmClient(opts: LlmOptions = {}): LlmClient {
  return {
    config: () => opts.config ?? resolveLlmConfig(),
    async generate(input) {
      const config = opts.config ?? resolveLlmConfig()
      try {
        const res = await generateText({
          model: providerFor(config, opts.fetch).chatModel(config.model),
          ...(input.system ? { system: input.system } : {}),
          prompt: input.prompt,
          // sin reintentos del SDK: reintentar es trabajo de BullMQ, y un
          // endpoint local caído debe fallar ya con el mensaje explícito
          maxRetries: 0,
        })
        return {
          text: res.text.trim(),
          inputTokens: res.usage.inputTokens ?? 0,
          outputTokens: res.usage.outputTokens ?? 0,
          model: config.model,
        }
      } catch (err) {
        throw friendlyLlmError(err, config)
      }
    },
  }
}
