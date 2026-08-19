/**
 * Adaptador de Evolution API v2. Cero dependencias de runtime: solo fetch
 * global y AbortSignal.timeout (Node >= 17.3). Cada método replica un
 * endpoint HTTP; la interpretación de la respuesta vive aquí para que las
 * rutas de la API no conozcan los quirks de Evolution.
 */

export type WaConnectionState = 'connecting' | 'connected' | 'disconnected'

export interface EvolutionConfig {
  baseUrl: string
  apiKey: string
  /** Timeout por request; Evolution puede tardar en el arranque en frío. */
  timeoutMs?: number
  /** Inyectable para tests; en producción siempre el fetch global. */
  fetch?: typeof fetch
}

export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EvolutionError'
  }
}

export interface QrResult {
  base64: string | null
  code: string | null
}

export interface SendPresenceInput {
  number: string
  presence?: string
  /** Cuánto se muestra el indicador de "escribiendo", en ms. */
  delayMs?: number
}

/** Lo mínimo que la API necesita del envío; el resto del response se ignora. */
export interface SendTextResult {
  messageId: string | null
}

export interface EvolutionClient {
  createInstance(instanceName: string): Promise<void>
  setWebhook(instanceName: string, opts: { url: string; secret: string }): Promise<void>
  connectionState(instanceName: string): Promise<WaConnectionState>
  /** QR de vinculación: base64 (imagen) o code (pairing code por número). */
  connect(instanceName: string): Promise<QrResult>
  /** Cierre de sesión en WhatsApp: best-effort, nunca lanza. */
  logout(instanceName: string): Promise<void>
  /** Borra la instancia en Evolution. 404 cuenta como borrada. */
  deleteInstance(instanceName: string): Promise<void>
  sendText(instanceName: string, input: { number: string; text: string }): Promise<SendTextResult>
  sendPresence(instanceName: string, input: SendPresenceInput): Promise<void>
  /** Baja el audio de un mensaje; lo usa el job de transcripción (fase 3). */
  getMediaBase64(instanceName: string, messageId: string): Promise<unknown>
  /** Sincronización de contactos/chats; la usa la fase 4. */
  findContacts(instanceName: string): Promise<unknown>
  findChats(instanceName: string): Promise<unknown>
}

export function createEvolutionClient(config: EvolutionConfig): EvolutionClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 15_000
  const doFetch = config.fetch ?? fetch

  async function request(
    method: string,
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<Response> {
    return doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        apikey: config.apiKey,
        'content-type': 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  async function requestJson(
    method: string,
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<unknown> {
    const res = await request(method, path, opts)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new EvolutionError(
        `${method} ${path} → ${res.status} ${detail.slice(0, 200)}`,
        res.status,
      )
    }
    const text = await res.text()
    if (!text) return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new EvolutionError(`${method} ${path} → respuesta no es JSON`)
    }
  }

  return {
    async createInstance(instanceName) {
      const res = await request('POST', '/instance/create', {
        body: {
          instanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
        },
      })
      // 403/409: la instancia ya existe (re-conectar tras un reinicio de la
      // API). Es el resultado que queríamos, no un error.
      if (res.ok || res.status === 403 || res.status === 409) return
      const detail = await res.text().catch(() => '')
      throw new EvolutionError(`create ${instanceName} → ${res.status} ${detail.slice(0, 200)}`, res.status)
    },

    async setWebhook(instanceName, { url, secret }) {
      await requestJson('POST', `/webhook/set/${encodeURIComponent(instanceName)}`, {
        body: {
          enabled: true,
          url,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
          headers: { 'x-webhook-secret': secret },
        },
      })
    },

    async connectionState(instanceName) {
      try {
        const json = (await requestJson(
          'GET',
          `/instance/connectionState/${encodeURIComponent(instanceName)}`,
        )) as { instance?: { state?: unknown } }
        const state = json?.instance?.state
        if (state === 'open') return 'connected'
        if (state === 'connecting') return 'connecting'
        // close, refused y cualquier otro valor: sin sesión útil.
        return 'disconnected'
      } catch {
        // fail-safe: si no podemos preguntar, asumimos desconectado
        return 'disconnected'
      }
    },

    async connect(instanceName) {
      const json = (await requestJson(
        'GET',
        `/instance/connect/${encodeURIComponent(instanceName)}`,
      )) as { base64?: unknown; code?: unknown }
      return {
        base64: typeof json?.base64 === 'string' && json.base64 ? json.base64 : null,
        code: typeof json?.code === 'string' && json.code ? json.code : null,
      }
    },

    async logout(instanceName) {
      try {
        await requestJson('DELETE', `/instance/logout/${encodeURIComponent(instanceName)}`)
      } catch (err) {
        // best-effort: cerrar sesión de una instancia rota igual debe permitir
        // seguir con el reset
        console.error(`[evolution] logout ${instanceName} falló (se ignora):`, err instanceof Error ? err.message : err)
      }
    },

    async deleteInstance(instanceName) {
      const res = await request('DELETE', `/instance/delete/${encodeURIComponent(instanceName)}`)
      if (res.ok || res.status === 404) return
      const detail = await res.text().catch(() => '')
      throw new EvolutionError(`delete ${instanceName} → ${res.status} ${detail.slice(0, 200)}`, res.status)
    },

    async sendText(instanceName, { number, text }) {
      const json = (await requestJson('POST', `/message/sendText/${encodeURIComponent(instanceName)}`, {
        body: { number, text },
      })) as { key?: { id?: unknown } }
      const id = json?.key?.id
      return { messageId: typeof id === 'string' && id ? id : null }
    },

    async sendPresence(instanceName, input) {
      await requestJson('POST', `/chat/sendPresence/${encodeURIComponent(instanceName)}`, {
        body: {
          number: input.number,
          presence: input.presence ?? 'composing',
          delay: input.delayMs ?? 1500,
        },
      })
    },

    async getMediaBase64(instanceName, messageId) {
      return requestJson('POST', `/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
        body: { message: { key: { id: messageId } }, convertToMp4: false },
      })
    },

    async findContacts(instanceName) {
      return requestJson('POST', `/chat/findContacts/${encodeURIComponent(instanceName)}`)
    },

    async findChats(instanceName) {
      return requestJson('POST', `/chat/findChats/${encodeURIComponent(instanceName)}`)
    },
  }
}
