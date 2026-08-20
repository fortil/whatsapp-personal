import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
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
import type { LlmClient } from '@wp/llm'
import {
  COLD_START_WINDOW_DAYS,
  NEW_MESSAGES_THRESHOLD,
  estimateTokens,
  extractHistoryMessages,
  historyMessageRow,
  REDUCE_MAX_ROUNDS,
  renderMessage,
  splitUnderCap,
  summarizeConversation,
  trimOldestLines,
} from './summarize.js'

/**
 * El núcleo del resumen contra el postgres real, con el LLM grabado: lo
 * critico de esta fase es el incremental por watermark de created_at (un
 * mensaje que llega tarde con sent_at viejo ENTRA al siguiente resumen), el
 * umbral de 20 mensajes y el tope de tokens con map-reduce.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`

let db: Db
let userId: string
let convId: string
let convNoHistoryId: string
const suiteUserIds: string[] = []

interface RecordedLlm extends LlmClient {
  prompts: string[]
}

function fakeLlm(respond: (prompt: string) => string): RecordedLlm {
  const prompts: string[] = []
  return {
    prompts,
    config: () => ({ provider: 'local', baseUrl: 'http://llm.test', model: 'test-model' }),
    async generate({ prompt }) {
      prompts.push(prompt)
      return {
        text: respond(prompt),
        inputTokens: estimateTokens(prompt),
        outputTokens: 12,
        model: 'test-model',
      }
    },
  }
}

const minutes = (n: number) => new Date(Date.now() - n * 60_000)

async function seedMessage(opts: {
  externalId: string
  body?: string | null
  type?: 'text' | 'audio'
  transcript?: string | null
  direction?: 'in' | 'out'
  sentAt?: Date
  createdAt?: Date
  conversationId?: string
}) {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: opts.conversationId ?? convId,
      userId,
      externalId: opts.externalId,
      direction: opts.direction ?? 'in',
      type: opts.type ?? 'text',
      body: opts.body ?? null,
      transcript: opts.transcript ?? null,
      sentAt: opts.sentAt ?? minutes(30),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning()
  return row!
}

/** Conversación propia del test: siembra la suya para poder correr solo (-t). */
async function seedConversation(waJid: string, displayName: string): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({ userId, waJid, displayName })
    .returning()
  const [conv] = await db
    .insert(conversations)
    .values({ userId, contactId: contact!.id, waJid })
    .returning()
  return conv!.id
}

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-summarize.${RUN}@mail.test`,
      phone: `+57304${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)

  await db.insert(waInstances).values({ userId, instanceName: `u_sum${RUN}`, state: 'connected' })

  const [contact] = await db
    .insert(contacts)
    .values({ userId, waJid: '573006667788@s.whatsapp.net', displayName: 'Conversación principal' })
    .returning()
  const [conv] = await db
    .insert(conversations)
    .values({ userId, contactId: contact!.id, waJid: contact!.waJid })
    .returning()
  convId = conv!.id

  const [contact2] = await db
    .insert(contacts)
    .values({ userId, waJid: '573006667799@s.whatsapp.net', displayName: 'Sin historial' })
    .returning()
  const [conv2] = await db
    .insert(conversations)
    .values({ userId, contactId: contact2!.id, waJid: contact2!.waJid })
    .returning()
  convNoHistoryId = conv2!.id
})

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.userId, suiteUserIds)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(waInstances).where(inArray(waInstances.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

describe('renderMessage', () => {
  it('audio sin transcript entra como [audio]; con transcript entra el texto', () => {
    expect(renderMessage({ direction: 'in', type: 'audio', body: null, transcript: null })).toBe('Contacto: [audio]')
    expect(renderMessage({ direction: 'in', type: 'audio', body: null, transcript: ' habla clara ' })).toBe(
      'Contacto: habla clara',
    )
  })

  it('body mayor a 500 caracteres queda truncado', () => {
    const rendered = renderMessage({ direction: 'out', type: 'text', body: 'a'.repeat(600), transcript: null })
    expect(rendered.startsWith('Yo: ')).toBe(true)
    expect(rendered.length).toBeLessThanOrEqual('Yo: '.length + 501)
  })

  it('otros medios entran como chip de tipo', () => {
    expect(renderMessage({ direction: 'in', type: 'image', body: null, transcript: null })).toBe('Contacto: [image]')
  })
})

describe('tope de tokens (funciones puras)', () => {
  it('trimOldestLines recorta las líneas más viejas hasta caber', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Contacto: mensaje ${i} ${'x'.repeat(100)}`)
    const transcript = lines.join('\n')
    const { text, dropped } = trimOldestLines(transcript, 500)
    expect(dropped).toBeGreaterThan(0)
    expect(estimateTokens(text)).toBeLessThanOrEqual(500)
    // sobreviven las más nuevas, no las más viejas
    expect(text).toContain('mensaje 49')
    expect(text).not.toContain('mensaje 0')
  })

  it('splitUnderCap produce fragmentos consecutivos, todos bajo el tope', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Yo: línea ${i} ${'y'.repeat(80)}`)
    const chunks = splitUnderCap(lines.join('\n'), 300)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(300)
    // sin perder líneas: la concatenación conserva todas en orden
    expect(chunks.join('\n').split('\n').length).toBe(60)
  })
})

describe('extractHistoryMessages / historyMessageRow', () => {
  it('acepta arreglo raíz, {messages:[...]} y la envoltura Baileys {messages:[{messages:[...]}]}', () => {
    const raw = [{ key: { id: 'A' } }]
    expect(extractHistoryMessages(raw)).toEqual(raw)
    expect(extractHistoryMessages({ messages: raw })).toEqual(raw)
    expect(extractHistoryMessages({ messages: [{ messages: raw }] })).toEqual(raw)
    expect(extractHistoryMessages({ otra: 1 })).toEqual([])
  })

  it('historyMessageRow mapea key.id, fromMe, texto y timestamp', () => {
    const row = historyMessageRow({
      key: { id: 'H1', remoteJid: '573001111111@s.whatsapp.net', fromMe: true },
      message: { conversation: 'buenas' },
      messageTimestamp: 1787000000,
    })
    expect(row).toEqual({
      externalId: 'H1',
      direction: 'out',
      type: 'text',
      body: 'buenas',
      sentAt: new Date(1787000000 * 1000),
    })
  })

  it('entradas sin texto aportan null', () => {
    expect(historyMessageRow({ key: { id: 'X' }, messageTimestamp: 1 })).toBeNull()
    expect(historyMessageRow(null)).toBeNull()
  })
})

describe('summarizeConversation', () => {
  it('conversación sin mensajes y sin historia remota: skipped-empty sin llamar al modelo', async () => {
    const llm = fakeLlm(() => 'resumen')
    const result = await summarizeConversation(userId, convNoHistoryId, {}, { db, llm, evolution: null })
    expect(result.status).toBe('skipped-empty')
    expect(llm.prompts.length).toBe(0)
  })

  it('findMessages fallando no tumba el job: resume con lo que hay (cero)', async () => {
    const evolution: EvolutionClient = {
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
        return {}
      },
      async findContacts() {
        return []
      },
      async findChats() {
        return []
      },
      async findMessages() {
        throw new Error('paginación rota')
      },
    }
    const llm = fakeLlm(() => 'resumen')
    const result = await summarizeConversation(userId, convNoHistoryId, {}, { db, llm, evolution })
    expect(result.status).toBe('skipped-empty')
    expect(llm.prompts.length).toBe(0)
  })

  it('arranque en frío: findMessages llena la DB y el primer resumen cubre ese historial', async () => {
    const history = [
      {
        key: { id: `COLD-1-${RUN}`, remoteJid: '573006667799@s.whatsapp.net' },
        message: { conversation: 'primero del historial' },
        messageTimestamp: 1786000000,
      },
      {
        key: { id: `COLD-2-${RUN}`, remoteJid: '573006667799@s.whatsapp.net', fromMe: true },
        message: { extendedTextMessage: { text: 'segundo del historial' } },
        messageTimestamp: 1786000100,
      },
      {
        key: { id: `COLD-AUDIO-${RUN}`, remoteJid: '573006667799@s.whatsapp.net' },
        message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 8 } },
        messageTimestamp: 1786000200,
      },
      {
        key: { id: `COLD-IMAGE-${RUN}`, remoteJid: '573006667799@s.whatsapp.net' },
        message: { imageMessage: { mimetype: 'image/jpeg' } },
        messageTimestamp: 1786000300,
      },
      {
        key: { id: `COLD-VIDEO-${RUN}`, remoteJid: '573006667799@s.whatsapp.net' },
        message: { videoMessage: { mimetype: 'video/mp4', seconds: 12 } },
        messageTimestamp: 1786000400,
      },
      {
        key: { id: `COLD-DOC-${RUN}`, remoteJid: '573006667799@s.whatsapp.net' },
        message: { documentMessage: { filename: 'notas.pdf', mimetype: 'application/pdf' } },
        messageTimestamp: 1786000500,
      },
      {
        key: { id: `COLD-STICKER-${RUN}`, remoteJid: '573006667799@s.whatsapp.net' },
        message: { stickerMessage: { mimetype: 'image/webp' } },
        messageTimestamp: 1786000600,
      },
    ]
    let page = 0
    const evolution: EvolutionClient = {
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
        return {}
      },
      async findContacts() {
        return []
      },
      async findChats() {
        return []
      },
      async findMessages(_instance, input) {
        page = input.page
        return page === 0 ? { messages: history } : { messages: [] }
      },
    }
    const llm = fakeLlm(() => 'resumen del historial')
    const result = await summarizeConversation(userId, convNoHistoryId, {}, { db, llm, evolution })
    expect(result.status).toBe('done')

    const inserted = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convNoHistoryId))
    expect(inserted.length).toBe(7)
    // cada rama de tipo de historyMessageRow deja la fila con su type y sin body
    const byExternal = new Map(inserted.map((m) => [m.externalId, m.type]))
    expect(byExternal.get(`COLD-1-${RUN}`)).toBe('text')
    expect(byExternal.get(`COLD-2-${RUN}`)).toBe('text')
    expect(byExternal.get(`COLD-AUDIO-${RUN}`)).toBe('audio')
    expect(byExternal.get(`COLD-IMAGE-${RUN}`)).toBe('image')
    expect(byExternal.get(`COLD-VIDEO-${RUN}`)).toBe('video')
    expect(byExternal.get(`COLD-DOC-${RUN}`)).toBe('document')
    expect(byExternal.get(`COLD-STICKER-${RUN}`)).toBe('sticker')
    for (const m of inserted) {
      if (m.type !== 'text') expect(m.body).toBeNull()
    }
    // y en el transcript del resumen los medios entran como chips de tipo
    expect(llm.prompts[0]).toContain('primero del historial')
    expect(llm.prompts[0]).toContain('segundo del historial')
    expect(llm.prompts[0]).toContain('[audio]')
    expect(llm.prompts[0]).toContain('[image]')
    expect(llm.prompts[0]).toContain('[video]')
    expect(llm.prompts[0]).toContain('[document]')
    expect(llm.prompts[0]).toContain('[sticker]')

    const conv = (await db.select().from(conversations).where(eq(conversations.id, convNoHistoryId)).limit(1))[0]!
    expect(conv.summary).toBe('resumen del historial')
    expect(conv.summaryModel).toBe('test-model')
    expect(conv.summaryThruCreatedAt).not.toBeNull()
  })

  it('primer resumen: audio como [audio]/transcript, coste 0 en local, watermark escrito', async () => {
    await seedMessage({ externalId: `S-TEXT-${RUN}`, body: 'hola, ¿qué tal?', sentAt: minutes(50), createdAt: minutes(49) })
    await seedMessage({ externalId: `S-AUDIO-${RUN}`, type: 'audio', sentAt: minutes(40), createdAt: minutes(39) })
    await seedMessage({
      externalId: `S-AUDIOT-${RUN}`,
      type: 'audio',
      transcript: 'audio transcrito antes',
      sentAt: minutes(35),
      createdAt: minutes(34),
    })
    await seedMessage({ externalId: `S-OUT-${RUN}`, body: 'todo bien', direction: 'out', sentAt: minutes(30), createdAt: minutes(29) })

    const llm = fakeLlm(() => 'primer resumen')
    const result = await summarizeConversation(userId, convId, {}, { db, llm, evolution: null })
    expect(result.status).toBe('done')
    expect(result.costUsd).toBe(0)
    expect(llm.prompts.length).toBe(1)
    expect(llm.prompts[0]).toContain('Contacto: hola, ¿qué tal?')
    expect(llm.prompts[0]).toContain('Contacto: [audio]')
    expect(llm.prompts[0]).toContain('Contacto: audio transcrito antes')
    expect(llm.prompts[0]).toContain('Yo: todo bien')

    const conv = (await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1))[0]!
    expect(conv.summary).toBe('primer resumen')
    expect(conv.summaryUpdatedAt).not.toBeNull()
  })

  it('umbral: menos de 20 mensajes nuevos no re-resume', async () => {
    // conversación propia: el umbral se prueba sobre un summary que este test
    // sembró, no sobre el watermark que deje otro
    const ownConvId = await seedConversation('573006667703@s.whatsapp.net', 'Umbral')
    await seedMessage({ conversationId: ownConvId, externalId: `S-TH-BASE-${RUN}`, body: 'base del umbral' })
    const base = fakeLlm(() => 'resumen base')
    expect((await summarizeConversation(userId, ownConvId, {}, { db, llm: base, evolution: null })).status).toBe(
      'done',
    )

    for (let i = 0; i < 5; i += 1) {
      await seedMessage({ conversationId: ownConvId, externalId: `S-TH5-${i}-${RUN}`, body: `nuevo ${i}` })
    }
    const llm = fakeLlm(() => 'no debería usarse')
    const result = await summarizeConversation(userId, ownConvId, {}, { db, llm, evolution: null })
    expect(result.status).toBe('skipped-threshold')
    expect(llm.prompts.length).toBe(0)
    const conv = (await db.select().from(conversations).where(eq(conversations.id, ownConvId)).limit(1))[0]!
    expect(conv.summary).toBe('resumen base')
  })

  it('force pisa el umbral: resume aunque falten mensajes para el umbral', async () => {
    const ownConvId = await seedConversation('573006667704@s.whatsapp.net', 'Forzado')
    await seedMessage({ conversationId: ownConvId, externalId: `S-F-BASE-${RUN}`, body: 'base del force' })
    await summarizeConversation(userId, ownConvId, {}, { db, llm: fakeLlm(() => 'resumen base'), evolution: null })
    await seedMessage({ conversationId: ownConvId, externalId: `S-F-NEW-${RUN}`, body: 'llegó algo nuevo' })

    const llm = fakeLlm(() => 'resumen forzado')
    const result = await summarizeConversation(userId, ownConvId, { force: true }, { db, llm, evolution: null })
    expect(result.status).toBe('done')
    expect(llm.prompts.length).toBe(1)
    expect(llm.prompts[0]).toContain('Resumen anterior de la conversación')
  })

  it('EL CASO DE ACEPTACIÓN: mensaje tardío (sent_at viejo, created_at nuevo) entra al siguiente resumen', async () => {
    const ownConvId = await seedConversation('573006667705@s.whatsapp.net', 'Tardío')
    // primer resumen propio: deja el summary y el watermark sobre los que
    // llega el tardío
    await seedMessage({ conversationId: ownConvId, externalId: `S-LATE-BASE-${RUN}`, body: 'base antes del tardío' })
    await summarizeConversation(userId, ownConvId, {}, { db, llm: fakeLlm(() => 'resumen base'), evolution: null })

    // el mensaje tardío llega ahora con sent_at de hace 40 días
    await seedMessage({
      conversationId: ownConvId,
      externalId: `S-LATE-${RUN}`,
      body: 'mensaje offline que llegó tarde',
      sentAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    })
    // completa el lote hasta cruzar el umbral de 20
    for (let i = 0; i < NEW_MESSAGES_THRESHOLD; i += 1) {
      await seedMessage({ conversationId: ownConvId, externalId: `S-BURST-${i}-${RUN}`, body: `mensaje nuevo ${i}` })
    }

    const llm = fakeLlm(() => 'resumen con el tardío')
    const result = await summarizeConversation(userId, ownConvId, {}, { db, llm, evolution: null })
    expect(result.status).toBe('done')
    expect(llm.prompts.length).toBe(1)
    expect(llm.prompts[0]).toContain('mensaje offline que llegó tarde')
    expect(llm.prompts[0]).toContain(`mensaje nuevo ${NEW_MESSAGES_THRESHOLD - 1}`)

    // y el watermark avanza hasta cubrir el created_at del tardío: una
    // pasada posterior no lo vuelve a procesar
    const late = (
      await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, ownConvId), eq(messages.externalId, `S-LATE-${RUN}`)))
        .limit(1)
    )[0]!
    const conv = (await db.select().from(conversations).where(eq(conversations.id, ownConvId)).limit(1))[0]!
    expect(conv.summary).toBe('resumen con el tardío')
    expect(conv.summaryThruCreatedAt!.getTime()).toBeGreaterThanOrEqual(late.createdAt.getTime())

    const llm2 = fakeLlm(() => 'segunda pasada')
    const again = await summarizeConversation(userId, ownConvId, {}, { db, llm: llm2, evolution: null })
    expect(again.status).toBe('skipped-empty')
    expect(llm2.prompts.length).toBe(0)
  })

  it('tope de tokens en frío: map-reduce en dos pasadas, cada fragmento bajo el tope', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ userId, waJid: '573006667700@s.whatsapp.net', displayName: 'Conversación enorme' })
      .returning()
    const [conv] = await db
      .insert(conversations)
      .values({ userId, contactId: contact!.id, waJid: contact!.waJid })
      .returning()
    // 120 mensajes de ~110 tokens: ~13k tokens, sobre el tope por defecto
    for (let i = 0; i < 120; i += 1) {
      await db.insert(messages).values({
        conversationId: conv!.id,
        userId,
        externalId: `S-BIG-${i}-${RUN}`,
        direction: 'in',
        type: 'text',
        body: `mensaje ${i} ${'z'.repeat(400)}`,
        sentAt: minutes(120 - i),
        createdAt: minutes(120 - i),
      })
    }

    const llm = fakeLlm((prompt) =>
      prompt.includes('Resúmenes parciales') ? 'resumen final integrado' : 'resumen parcial',
    )
    const cap = 2000
    const result = await summarizeConversation(userId, conv!.id, {}, { db, llm, evolution: null, tokenCap: cap })
    expect(result.status).toBe('done')

    const partials = llm.prompts.filter((p) => p.includes('Fragmento de la conversación'))
    const final = llm.prompts.filter((p) => p.includes('Resúmenes parciales'))
    expect(partials.length).toBeGreaterThan(1)
    expect(final.length).toBe(1)
    expect(result.passes).toBe(partials.length + 1)

    for (const p of partials) {
      const chunk = p.slice('Fragmento de la conversación:\n'.length, p.indexOf('\n\nEscribe el resumen parcial.'))
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(cap)
    }

    const row = (await db.select().from(conversations).where(eq(conversations.id, conv!.id)).limit(1))[0]!
    expect(row.summary).toBe('resumen final integrado')
  })

  it('reducción del map-reduce: los parciales que no caben se agrupan y se reducen por rondas', async () => {
    const ownConvId = await seedConversation('573006667706@s.whatsapp.net', 'Reducción')
    // 12 mensajes de ~103 tokens con tope 400: 4 fragmentos de 3 líneas. Cada
    // parcial responde 480 chars (~120 tokens) y 4×120 > 400: sin ronda de
    // integración el prompt final desbordaría el tope igual que el transcript
    for (let i = 0; i < 12; i += 1) {
      await seedMessage({
        conversationId: ownConvId,
        externalId: `S-RED-${i}-${RUN}`,
        body: `reducción ${i} ${'r'.repeat(390)}`,
        sentAt: minutes(60 - i),
        createdAt: minutes(60 - i),
      })
    }
    const llm = fakeLlm((prompt) => {
      if (prompt.startsWith('Fragmento de la conversación')) return `parcial ${'p'.repeat(472)}`
      if (prompt.startsWith('Ronda de integración')) {
        // el grupo de 3 parciales contra el de 1: respuestas distinguibles
        return prompt.split('\n').filter((l) => l.startsWith('parcial ')).length > 1
          ? 'integrado primero'
          : 'integrado segundo'
      }
      return 'resumen final integrado'
    })
    const cap = 400
    const result = await summarizeConversation(userId, ownConvId, {}, { db, llm, evolution: null, tokenCap: cap })
    expect(result.status).toBe('done')

    const maps = llm.prompts.filter((p) => p.startsWith('Fragmento de la conversación'))
    const rounds = llm.prompts.filter((p) => p.startsWith('Ronda de integración'))
    const finals = llm.prompts.filter((p) => p.includes('Escribe el resumen final'))
    expect(maps.length).toBe(4)
    // 4 parciales de 120 tokens: grupo de 3 + grupo de 1 en una ronda
    expect(rounds.length).toBe(2)
    expect(finals.length).toBe(1)
    expect(result.passes).toBe(4 + 2 + 1)

    // cada grupo de la ronda quedó bajo el tope...
    for (const r of rounds) {
      const group = r.slice(r.indexOf(':\n\n') + 3, r.lastIndexOf('\n\n'))
      expect(estimateTokens(group)).toBeLessThanOrEqual(cap)
    }
    // ...y el prompt final también, con los dos integrados
    const final = finals[0]!
    const finalGroup = final.slice(final.indexOf(':\n\n') + 3, final.lastIndexOf('\n\n'))
    expect(estimateTokens(finalGroup)).toBeLessThanOrEqual(cap)
    expect(finalGroup).toContain('integrado primero')
    expect(finalGroup).toContain('integrado segundo')
  })

  it('cota de rondas: un modelo que hace eco de su entrada no deja la reducción girando', async () => {
    const ownConvId = await seedConversation('573006667707@s.whatsapp.net', 'Eco')
    // mismo molde que el test de arriba: 4 fragmentos cuyos parciales juntos
    // desbordan el tope
    for (let i = 0; i < 12; i += 1) {
      await seedMessage({
        conversationId: ownConvId,
        externalId: `S-ECO-${i}-${RUN}`,
        body: `eco ${i} ${'c'.repeat(390)}`,
        sentAt: minutes(60 - i),
        createdAt: minutes(60 - i),
      })
    }
    const cap = 400
    // la ronda de integración responde 221 tokens por grupo (dos grupos = 442
    // > 400): el tamaño no baja nunca, la reducción no converge sola
    const echo = `eco ${'e'.repeat(879)}`
    const llm = fakeLlm((prompt) => {
      if (prompt.startsWith('Fragmento de la conversación')) return `parcial ${'p'.repeat(472)}`
      if (prompt.startsWith('Ronda de integración')) return echo
      return 'resumen final tras el eco'
    })
    const result = await summarizeConversation(userId, ownConvId, {}, { db, llm, evolution: null, tokenCap: cap })
    expect(result.status).toBe('done')

    const maps = llm.prompts.filter((p) => p.startsWith('Fragmento de la conversación'))
    const rounds = llm.prompts.filter((p) => p.startsWith('Ronda de integración'))
    const finals = llm.prompts.filter((p) => p.includes('Escribe el resumen final'))
    expect(maps.length).toBe(4)
    // sin la cota este test no termina: el eco mantiene el tope desbordado.
    // Cada ronda agrupa los parciales en 2 (3 líneas + 1 la primera, 1 eco
    // por grupo después), así que son REDUCE_MAX_ROUNDS rondas de 2 prompts
    expect(rounds.length).toBe(REDUCE_MAX_ROUNDS * 2)
    expect(finals.length).toBe(1)
    expect(result.passes).toBe(4 + REDUCE_MAX_ROUNDS * 2 + 1)

    // la salida de emergencia es el recorte: el prompt final queda bajo el
    // tope con los parciales (eco) más recientes
    const final = finals[0]!
    const finalGroup = final.slice(final.indexOf(':\n\n') + 3, final.lastIndexOf('\n\n'))
    expect(estimateTokens(finalGroup)).toBeLessThanOrEqual(cap)
    expect(finalGroup).toContain('eco ')
  })

  it('incremental desbordado: una sola pasada con los más viejos recortados', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ userId, waJid: '573006667701@s.whatsapp.net', displayName: 'Ráfaga' })
      .returning()
    const [conv] = await db
      .insert(conversations)
      .values({ userId, contactId: contact!.id, waJid: contact!.waJid })
      .returning()
    await db.insert(messages).values({
      conversationId: conv!.id,
      userId,
      externalId: `S-BASE-${RUN}`,
      direction: 'in',
      type: 'text',
      body: 'base de la conversación',
      sentAt: minutes(200),
      createdAt: minutes(200),
    })
    const llm = fakeLlm(() => 'resumen base')
    await summarizeConversation(userId, conv!.id, {}, { db, llm, evolution: null })

    // ráfaga de 40 mensajes grandes: sobre el tope, pero con summary previo
    for (let i = 0; i < 40; i += 1) {
      await db.insert(messages).values({
        conversationId: conv!.id,
        userId,
        externalId: `S-BURST2-${i}-${RUN}`,
        direction: 'in',
        type: 'text',
        body: `ráfaga ${i} ${'w'.repeat(300)}`,
        sentAt: minutes(100 - i),
        createdAt: minutes(100 - i),
      })
    }
    const llm2 = fakeLlm(() => 'resumen con ráfaga')
    const cap = 1500
    const result = await summarizeConversation(userId, conv!.id, {}, { db, llm: llm2, evolution: null, tokenCap: cap })
    expect(result.status).toBe('done')
    expect(result.passes).toBe(1)
    expect(llm2.prompts.length).toBe(1)
    expect(llm2.prompts[0]).toContain('los más recientes')
    expect(llm2.prompts[0]).toContain('ráfaga 39')
    expect(llm2.prompts[0]).not.toContain('ráfaga 0')
  })

  it('ventana de arranque en frío: mensajes de más de 30 días quedan fuera del primer resumen', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ userId, waJid: '573006667702@s.whatsapp.net', displayName: 'Ventana 30 días' })
      .returning()
    const [conv] = await db
      .insert(conversations)
      .values({ userId, contactId: contact!.id, waJid: contact!.waJid })
      .returning()
    await db.insert(messages).values({
      conversationId: conv!.id,
      userId,
      externalId: `S-OLD-${RUN}`,
      direction: 'in',
      type: 'text',
      body: 'mensaje insertado hace 40 días',
      sentAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - (COLD_START_WINDOW_DAYS + 10) * 24 * 60 * 60 * 1000),
    })
    await db.insert(messages).values({
      conversationId: conv!.id,
      userId,
      externalId: `S-RECENT-${RUN}`,
      direction: 'in',
      type: 'text',
      body: 'mensaje insertado ayer',
      sentAt: minutes(1440),
      createdAt: minutes(1440),
    })

    const llm = fakeLlm(() => 'resumen de la ventana')
    const result = await summarizeConversation(userId, conv!.id, {}, { db, llm, evolution: null })
    expect(result.status).toBe('done')
    expect(llm.prompts[0]).toContain('mensaje insertado ayer')
    expect(llm.prompts[0]).not.toContain('mensaje insertado hace 40 días')
  })

  it('conversación de otro usuario: error, no resumen silencioso', async () => {
    const [other] = await db
      .insert(users)
      .values({
        email: `worker-summarize-b.${RUN}@mail.test`,
        phone: `+57305${RUN.slice(-6).padStart(6, '0')}`,
        passwordHash: 'x:y',
        status: 'approved',
      })
      .returning()
    suiteUserIds.push(other!.id)
    const llm = fakeLlm(() => 'no debe llegar')
    await expect(summarizeConversation(other!.id, convId, {}, { db, llm, evolution: null })).rejects.toThrow(
      /no existe para este usuario/,
    )
  })
})
