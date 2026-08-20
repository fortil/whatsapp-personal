import { and, eq, sql } from 'drizzle-orm'
import { getDb, contacts, conversations, taskRuns, waInstances, type Db } from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import { parseLoosePhone } from '@wp/shared'

/**
 * Job contacts_sync: vuelca findContacts + findChats de la instancia del
 * usuario a contacts/conversations. Convive con lo que ya creó ingest.ts:
 * el upsert es por (user_id, wa_jid) y solo RELLENA campos vacíos, nunca
 * pisa display_name ni el teléfono que el usuario o el ingest dejaron.
 * Grupos (@g.us) y status@broadcast quedan fuera (v1 es 1:1).
 */

export interface SyncedContact {
  waJid: string
  /** pushName/wa_name tal como lo trae Evolution; puede venir vacío. */
  waName: string | null
  /** timestamp del último mensaje cuando la entrada es de findChats. */
  lastMessageAt: Date | null
}

/** findContacts/findChats: la respuesta de Evolution v2 cambia de forma entre versiones. */
function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>
    for (const key of ['contacts', 'chats']) {
      if (Array.isArray(root[key])) return root[key]
    }
    // envuelto en { response: {...} } como getBase64FromMediaMessage
    if (root.response && typeof root.response === 'object') return asArray(root.response)
  }
  return []
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Cada entrada puede traer el jid como remoteJid, id.remoteJid o id a secas
 * (Baileys serializa el jid de varias formas según el endpoint).
 */
export function entryToContact(entry: unknown): SyncedContact | null {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const nested = record.id && typeof record.id === 'object' ? (record.id as Record<string, unknown>) : {}
  const jid =
    str(record.remoteJid) ?? str(nested.remoteJid) ?? str(record.id) ?? str(record.jid) ?? str(record.waJid)
  if (!jid) return null
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return null
  const ts = Number(record.lastMessageTimestamp ?? record.timestamp)
  return {
    waJid: jid,
    waName: str(record.pushName) ?? str(record.name),
    lastMessageAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null,
  }
}

/** Upsert por (user_id, wa_jid) que solo rellena huecos: el sync no duplica ni pisa. */
async function upsertContact(db: Db, userId: string, synced: SyncedContact): Promise<void> {
  const existing = (
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.waJid, synced.waJid)))
      .limit(1)
  )[0]
  if (!existing) {
    await db
      .insert(contacts)
      .values({
        userId,
        waJid: synced.waJid,
        phoneE164: synced.waJid.endsWith('@lid') ? null : parseLoosePhone(synced.waJid.split('@')[0] ?? ''),
        isLid: synced.waJid.endsWith('@lid'),
        waName: synced.waName,
      })
      .onConflictDoNothing()
    return
  }
  const fill: Partial<typeof contacts.$inferInsert> = {}
  if (synced.waName && !existing.waName) fill.waName = synced.waName
  if (!synced.waJid.endsWith('@lid') && !existing.phoneE164) {
    const phone = parseLoosePhone(synced.waJid.split('@')[0] ?? '')
    if (phone) fill.phoneE164 = phone
  }
  if (Object.keys(fill).length > 0) {
    await db.update(contacts).set(fill).where(eq(contacts.id, existing.id))
  }
}

/** La conversación de un jid, creada si el sync la conoce antes que el primer mensaje. */
async function upsertConversation(db: Db, userId: string, jid: string, lastMessageAt: Date | null) {
  const existing = (
    await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.waJid, jid)))
      .limit(1)
  )[0]
  if (existing) {
    // last_message_at solo avanza, igual que en ingest: los mensajes
    // offline llegan con sent_at viejo
    if (lastMessageAt && (!existing.lastMessageAt || existing.lastMessageAt < lastMessageAt)) {
      await db
        .update(conversations)
        .set({ lastMessageAt })
        .where(eq(conversations.id, existing.id))
    }
    return
  }
  const contact = (
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.waJid, jid)))
      .limit(1)
  )[0]
  await db
    .insert(conversations)
    .values({ userId, contactId: contact?.id, waJid: jid, lastMessageAt })
    .onConflictDoNothing()
}

export interface ContactsSyncDeps {
  db?: Db
  evolution?: EvolutionClient | null
}

export interface ContactsSyncResult {
  contacts: number
  conversations: number
}

export async function runContactsSync(
  userId: string,
  taskRunId: string | null,
  deps: ContactsSyncDeps = {},
): Promise<ContactsSyncResult> {
  const db = deps.db ?? getDb()
  const instance = (
    await db.select().from(waInstances).where(eq(waInstances.userId, userId)).limit(1)
  )[0]
  const evolution = deps.evolution ?? null
  if (!instance || !evolution) {
    throw new Error('el usuario no tiene instancia de WhatsApp vinculada o falta la configuración de Evolution')
  }

  const touch = (processed: number, total: number) =>
    taskRunId
      ? db
          .update(taskRuns)
          .set({ status: 'running', processed, total, updatedAt: new Date() })
          .where(eq(taskRuns.id, taskRunId))
      : Promise.resolve()

  try {
    // las dos fuentes valen 1 unidad de progreso cada una: el panel muestra
    // avance grueso, no fila por fila (findContacts/findChats no paginan)
    await touch(0, 2)

    const rawContacts = asArray(await evolution.findContacts(instance.instanceName))
    const contactList = rawContacts.map(entryToContact).filter((c): c is SyncedContact => c !== null)
    for (const synced of contactList) await upsertContact(db, userId, synced)
    await touch(1, 2)

    const rawChats = asArray(await evolution.findChats(instance.instanceName))
    const chatList = rawChats.map(entryToContact).filter((c): c is SyncedContact => c !== null)
    for (const chat of chatList) {
      // los chats también revelan contactos (conversación sin entrada en la
      // agenda del teléfono); mismo upsert que no pisa nada
      await upsertContact(db, userId, chat)
      await upsertConversation(db, userId, chat.waJid, chat.lastMessageAt)
    }

    if (taskRunId) {
      await db
        .update(taskRuns)
        .set({ status: 'done', processed: 2, total: 2, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(taskRuns.id, taskRunId))
    }

    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.userId, userId))
    return { contacts: countRows[0]?.count ?? 0, conversations: chatList.length }
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
