import { describe, expect, it } from 'vitest'
import { computeCostUsd } from './costs.js'

describe('computeCostUsd', () => {
  it('modo local: costo 0 exacto, aunque el modelo no esté en la tabla', () => {
    expect(computeCostUsd('local', 'qwen3:8b', { inputTokens: 12_000, outputTokens: 500 })).toBe(0)
    expect(computeCostUsd('local', 'cualquier-cosa', { inputTokens: 0, outputTokens: 0 })).toBe(0)
  })

  it('qwen-flash con los precios publicados de Model Studio intl', () => {
    // 12k entrada + 600 salida: 12000*0.05/1M + 600*0.4/1M = 0.00084
    // Valor literal a propósito: si alguien teclea mal un precio en PRICES,
    // este test debe romperse (recalcularlo desde PRICES solo prueba la
    // fórmula, nunca los números).
    expect(computeCostUsd('dashscope', 'qwen-flash', { inputTokens: 12_000, outputTokens: 600 })).toBeCloseTo(
      0.00084,
      10,
    )
  })

  it('modelo fuera de la tabla: null, nunca un precio inventado', () => {
    expect(computeCostUsd('dashscope', 'modelo-desconocido', { inputTokens: 10, outputTokens: 10 })).toBeNull()
  })
})
