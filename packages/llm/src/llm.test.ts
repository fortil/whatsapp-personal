import { describe, expect, it } from 'vitest'
import { createLlmClient, friendlyLlmError, resolveLlmConfig } from './llm.js'

describe('resolveLlmConfig', () => {
  it('default: proveedor local contra el Ollama de la mini', () => {
    const config = resolveLlmConfig({})
    expect(config).toEqual({
      provider: 'local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:8b',
    })
  })

  it('local respeta base URL y modelo del env, y come slashes de más', () => {
    const config = resolveLlmConfig({
      LOCAL_LLM_BASE_URL: 'http://192.168.1.50:11434/v1///',
      LOCAL_LLM_MODEL: 'qwen3:14b',
    })
    expect(config.baseUrl).toBe('http://192.168.1.50:11434/v1')
    expect(config.model).toBe('qwen3:14b')
  })

  it('dashscope: endpoint intl compatible-mode con qwen-flash y su key', () => {
    const config = resolveLlmConfig({ LLM_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: 'sk-test' })
    expect(config).toEqual({
      provider: 'dashscope',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-flash',
      apiKey: 'sk-test',
    })
  })
})

describe('friendlyLlmError', () => {
  it('convierte el fetch fallido del modelo local en el mensaje literal del plan', () => {
    const err = friendlyLlmError(new TypeError('fetch failed'), {
      provider: 'local',
      baseUrl: 'http://192.168.1.50:11434/v1',
      model: 'qwen3:8b',
    })
    expect(err.message).toBe('no se pudo alcanzar el modelo local en http://192.168.1.50:11434/v1: fetch failed')
  })

  it('los errores de red de dashscope también nombran su endpoint', () => {
    const err = friendlyLlmError(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
      provider: 'dashscope',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-flash',
    })
    expect(err.message).toContain('no se pudo alcanzar el proveedor dashscope en https://dashscope-intl.aliyuncs.com')
  })

  it('un error que no es de red pasa igual', () => {
    const original = new Error('rate limit exceeded')
    expect(friendlyLlmError(original, { provider: 'local', baseUrl: 'http://x', model: 'm' })).toBe(original)
  })
})

describe('createLlmClient.generate', () => {
  it('un endpoint local muerto falla con el mensaje explícito, no con un timeout opaco', async () => {
    const client = createLlmClient({
      config: { provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'no-existe' },
    })
    await expect(client.generate({ prompt: 'hola' })).rejects.toThrow(
      /no se pudo alcanzar el modelo local en http:\/\/127\.0\.0\.1:9\/v1/,
    )
  })
})
