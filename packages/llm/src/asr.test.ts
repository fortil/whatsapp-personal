import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extensionFor, getTranscriptionConfig, transcribeAudio, TranscriptionError } from './asr.js'

describe('getTranscriptionConfig', () => {
  it('sin nada configurado devuelve null (error legible aguas abajo)', () => {
    expect(getTranscriptionConfig({})).toBeNull()
  })

  it('provider local: LOCAL_ASR_BASE_URL gana y apunta a /inference de whisper.cpp', () => {
    const config = getTranscriptionConfig({
      LLM_PROVIDER: 'local',
      LOCAL_ASR_BASE_URL: 'http://192.168.1.50:8081/',
      LOCAL_ASR_MODEL: 'large-v3-turbo',
      DASHSCOPE_API_KEY: 'sk-tambien-presente',
    })
    expect(config).toEqual({
      provider: 'local',
      baseUrl: 'http://192.168.1.50:8081',
      path: '/inference',
      model: 'large-v3-turbo',
    })
  })

  it('con LLM_PROVIDER=dashscope el ASR local se ignora y cae a DashScope', () => {
    const config = getTranscriptionConfig({
      LLM_PROVIDER: 'dashscope',
      LOCAL_ASR_BASE_URL: 'http://192.168.1.50:8081',
      DASHSCOPE_API_KEY: 'sk-x',
    })
    expect(config).toMatchObject({ provider: 'dashscope', model: 'qwen3-asr-flash', path: '/audio/transcriptions' })
  })

  it('sin ASR local ni dashscope, OPENAI_API_KEY responde con whisper-1', () => {
    const config = getTranscriptionConfig({ OPENAI_API_KEY: 'sk-oai' })
    expect(config).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      path: '/audio/transcriptions',
      model: 'whisper-1',
      apiKey: 'sk-oai',
    })
  })
})

describe('extensionFor', () => {
  it('mapea el ogg/opus de WhatsApp y los demás mimos del plan', () => {
    expect(extensionFor('audio/ogg; codecs=opus')).toBe('ogg')
    expect(extensionFor('audio/mpeg')).toBe('mp3')
    expect(extensionFor('audio/mp4')).toBe('mp4')
    expect(extensionFor('audio/x-m4a')).toBe('m4a')
    expect(extensionFor('audio/wav')).toBe('wav')
    expect(extensionFor('audio/webm')).toBe('webm')
    expect(extensionFor('audio/amr')).toBe('amr')
    expect(extensionFor('audio/3gpp')).toBe('3gpp')
    expect(extensionFor('audio/flac')).toBe('flac')
    expect(extensionFor(null)).toBe('bin')
    expect(extensionFor('audio/nuevo-formato')).toBe('bin')
  })
})

/** Mini servidor ASR: graba la request y contesta lo que el test configura. */
let server: http.Server
let serverUrl: string
const seen: Array<{ method?: string; url?: string; contentType?: string; auth?: string; bodyHead: string }> = []
let respond: { status: number; body: string } = { status: 200, body: JSON.stringify({ text: ' hola desde el asr \n' }) }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        auth: req.headers.authorization,
        bodyHead: Buffer.concat(chunks).toString('latin1').slice(0, 1200),
      })
      res.writeHead(respond.status, { 'content-type': 'application/json' })
      res.end(respond.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// función, no constante: serverUrl solo existe después del beforeAll
const localConfig = () => ({ provider: 'local' as const, baseUrl: serverUrl, path: '/inference', model: 'large-v3-turbo' })
const audio64 = Buffer.from('OGGDATA-falso').toString('base64')

describe('transcribeAudio', () => {
  it('manda multipart al path del proveedor y devuelve el texto recortado', async () => {
    seen.length = 0
    const text = await transcribeAudio({ base64: audio64, mimetype: 'audio/ogg; codecs=opus' }, localConfig())
    expect(text).toBe('hola desde el asr')
    expect(seen.length).toBe(1)
    const req = seen[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/inference')
    expect(req.contentType).toContain('multipart/form-data')
    // sin apiKey no viaja Authorization: whisper.cpp no la pide
    expect(req.auth).toBeUndefined()
    expect(req.bodyHead).toContain('audio.ogg')
    expect(req.bodyHead).toContain('large-v3-turbo')
    expect(req.bodyHead).toContain('response_format')
  })

  it('con apiKey (dashscope/openai) manda Bearer y usa el path OpenAI', async () => {
    seen.length = 0
    await transcribeAudio(
      { base64: audio64 },
      { provider: 'dashscope', baseUrl: serverUrl, path: '/audio/transcriptions', model: 'qwen3-asr-flash', apiKey: 'sk-1' },
    )
    expect(seen[0]!.url).toBe('/audio/transcriptions')
    expect(seen[0]!.auth).toBe('Bearer sk-1')
    expect(seen[0]!.bodyHead).toContain('qwen3-asr-flash')
  })

  it('audio vacío falla sin llamar a nadie', async () => {
    seen.length = 0
    await expect(transcribeAudio({ base64: '' }, localConfig())).rejects.toThrow('no hay nada que transcribir')
    expect(seen.length).toBe(0)
  })

  it('HTTP de error del ASR queda como mensaje legible con el status', async () => {
    respond = { status: 500, body: 'boom' }
    try {
      await expect(transcribeAudio({ base64: audio64 }, localConfig())).rejects.toThrow('HTTP 500')
    } finally {
      respond = { status: 200, body: JSON.stringify({ text: 'ok' }) }
    }
  })

  it('respuesta sin texto es error explícito', async () => {
    respond = { status: 200, body: JSON.stringify({ otro: 1 }) }
    try {
      await expect(transcribeAudio({ base64: audio64 }, localConfig())).rejects.toThrow('no trae texto')
    } finally {
      respond = { status: 200, body: JSON.stringify({ text: 'ok' }) }
    }
  })

  it('endpoint muerto: mensaje con la URL, no un ECONNREFUSED pelado', async () => {
    await expect(
      transcribeAudio(
        { base64: audio64 },
        { provider: 'local', baseUrl: 'http://127.0.0.1:9', path: '/inference', model: 'x' },
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow(TranscriptionError)
    await expect(
      transcribeAudio(
        { base64: audio64 },
        { provider: 'local', baseUrl: 'http://127.0.0.1:9', path: '/inference', model: 'x' },
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow('no se pudo alcanzar el ASR local en http://127.0.0.1:9')
  })
})
