import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import {
  closeClient,
  contacts,
  conversations,
  getDb,
  taskRuns,
  users,
  waInstances,
  type Db,
} from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import { runContactsSync } from './contacts-sync.js'

/**
 * contacts_sync contra el postgres real con un Evolution grabado: lo central
 * es que el sync CONVIVE con lo que ya creó ingest.ts sin duplicar (upsert
 * por (user_id, wa_jid) que solo rellena huecos) y que el task_run termina
 * done con el progreso que el panel pollea.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`

let db: Db
let userId: string
let existingContactId: string
let existingConversationId: string
let taskRunId: string
const suiteUserIds: string[] = []

const EXISTING_JID = '573001112233@s.whatsapp.net'
const NEW_CHAT_JID = '573005556677@s.whatsapp.net'
const LID_JID = '987654321@lid'

function syncEvolution(): EvolutionClient {
  return {
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
      return {
        contacts: [
          // el que ingest ya creó: mismo jid, mismo nombre
          { remoteJid: EXISTING_JID, pushName: 'María' },
          // LID: sin teléfono parseable
          { id: { remoteJid: LID_JID }, pushName: 'Amigo LID' },
          // grupo: fuera de v1
          { remoteJid: '12036302222222-333333@g.us', pushName: 'Grupo familia' },
        ],
      }
    },
    async findChats() {
      return {
        chats: [
          // timestamp del último mensaje más viejo que el que ya había: no
          // puede regresar last_message_at
          { remoteJid: EXISTING_JID, lastMessageTimestamp: 1780000000 },
          { remoteJid: NEW_CHAT_JID, pushName: 'Pedro nuevo', lastMessageTimestamp: 1787000001 },
        ],
      }
    },
    async findMessages() {
      return []
    },
  }
}

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-sync.${RUN}@mail.test`,
      phone: `+57302${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)

  await db.insert(waInstances).values({ userId, instanceName: `u_sync${RUN}`, state: 'connected' })

  // lo que ingest.ts habría dejado tras un mensaje entrante de María
  const [contact] = await db
    .insert(contacts)
    .values({
      userId,
      waJid: EXISTING_JID,
      phoneE164: '+573001112233',
      isLid: false,
      waName: 'María',
    })
    .returning()
  existingContactId = contact!.id
  const [conv] = await db
    .insert(conversations)
    .values({
      userId,
      contactId: existingContactId,
      waJid: EXISTING_JID,
      lastMessageAt: new Date(1785000000 * 1000),
    })
    .returning()
  existingConversationId = conv!.id

  const [taskRun] = await db
    .insert(taskRuns)
    .values({ userId, kind: 'contacts_sync', status: 'queued' })
    .returning()
  taskRunId = taskRun!.id
})

afterAll(async () => {
  await db.delete(taskRuns).where(inArray(taskRuns.userId, suiteUserIds)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(waInstances).where(inArray(waInstances.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

describe('runContactsSync', () => {
  it('sin instancia vinculada: error claro', async () => {
    const [ghost] = await db
      .insert(users)
      .values({
        email: `worker-sync-ghost.${RUN}@mail.test`,
        phone: `+57303${RUN.slice(-6).padStart(6, '0')}`,
        passwordHash: 'x:y',
        status: 'approved',
      })
      .returning()
    suiteUserIds.push(ghost!.id)
    await expect(runContactsSync(ghost!.id, null, { db, evolution: syncEvolution() })).rejects.toThrow(
      /no tiene instancia de WhatsApp/,
    )
  })

  it('sincroniza sin duplicar lo creado por ingest y marca LID/grupos', async () => {
    const result = await runContactsSync(userId, taskRunId, { db, evolution: syncEvolution() })

    // el jid existente queda en una sola fila, con sus datos intactos
    const existing = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.waJid, EXISTING_JID)))
    expect(existing.length).toBe(1)
    expect(existing[0]!.id).toBe(existingContactId)
    expect(existing[0]!.waName).toBe('María')
    expect(existing[0]!.phoneE164).toBe('+573001112233')

    // el LID entra marcado y sin teléfono
    const lid = (
      await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.userId, userId), eq(contacts.waJid, LID_JID)))
        .limit(1)
    )[0]
    expect(lid).toBeDefined()
    expect(lid!.isLid).toBe(true)
    expect(lid!.phoneE164).toBeNull()
    expect(lid!.waName).toBe('Amigo LID')

    // el grupo no genera nada
    const groups = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.waJid, '12036302222222-333333@g.us')))
    expect(groups.length).toBe(0)

    // el chat nuevo crea contacto con teléfono derivado del jid
    const nuevo = (
      await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.userId, userId), eq(contacts.waJid, NEW_CHAT_JID)))
        .limit(1)
    )[0]
    expect(nuevo).toBeDefined()
    expect(nuevo!.phoneE164).toBe('+573005556677')
    expect(nuevo!.waName).toBe('Pedro nuevo')

    // su conversación existe y la de María no regresó su last_message_at
    const nuevaConv = (
      await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.waJid, NEW_CHAT_JID)))
        .limit(1)
    )[0]
    expect(nuevaConv).toBeDefined()
    expect(nuevaConv!.contactId).toBe(nuevo!.id)
    const convExistente = (
      await db.select().from(conversations).where(eq(conversations.id, existingConversationId)).limit(1)
    )[0]!
    expect(convExistente.lastMessageAt?.getTime()).toBe(1785000000 * 1000)

    // el task_run queda done con el avance que muestra el panel
    const task = (await db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1))[0]!
    expect(task.status).toBe('done')
    expect(task.processed).toBe(2)
    expect(task.total).toBe(2)
    expect(task.finishedAt).not.toBeNull()

    expect(result.conversations).toBeGreaterThanOrEqual(1)
  })
})
