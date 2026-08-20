/**
 * Costo por llamada en USD. Los precios son los publicados por Alibaba Cloud
 * Model Studio (intl, inferencia real-time), verificados el 2026-08-19 en
 * https://www.alibabacloud.com/help/en/model-studio/model-pricing
 * El ASR de DashScope se cobra por segundo de audio ($0.000035/s para
 * qwen3-asr-flash), no por token: no entra en esta tabla.
 */

export interface ModelPrices {
  /** USD por millón de tokens de entrada. */
  input: number
  /** USD por millón de tokens de salida. */
  output: number
}

export const PRICES: Record<string, ModelPrices> = {
  // tier ≤256K de tokens de entrada por request (el de los resúmenes: ~12k)
  'qwen-flash': { input: 0.05, output: 0.4 },
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * null cuando el modelo no está en PRICES: el caller muestra "costo
 * desconocido" en vez de un número inventado. 0 exacto en modo local.
 */
export function computeCostUsd(
  provider: 'local' | 'dashscope',
  model: string,
  usage: TokenUsage,
): number | null {
  if (provider === 'local') return 0
  const prices = PRICES[model]
  if (!prices) return null
  return (usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000
}
