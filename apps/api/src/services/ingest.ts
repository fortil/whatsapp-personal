import { and, eq, isNull, sql } from 'drizzle-orm'
import { type Db, contacts, conversations, messages, msgTypeEnum } from '@wp/db'
import { parseLoosePhone } from '@wp/shared'

type MsgType = (typeof msgTypeEnum)['enumValues'][number]

/**
 * Ingest de messages.upsert de Evolution (payload Baileys). Las reglas duras:
 * grupos/broadcast y edit/reaction se ignoran con log (fuera de v1), fromMe
 * se persiste como out, y el INSERT lleva ON CONFLICT DO NOTHING para que los
 * reintentos de Evolution y la carrera webhook-vs-reply no dupliquen ni
 * revienten. El no-leído se deriva del índice parcial; aquí no hay contador
 * que mantener.
 */

export interface IngestResult {
  /** true cuando se creó la fila; false si ya existía (retry) o se ignoró. */
  inserted: boolean
  /** Motivo cuando el payload no genera mensaje. */
  ignored?: string
}

interface ParsedUpsert {
  jid: string
  fromMe: boolean
  externalId: string | null
  sentAt: Date
  type: MsgType
  body: string | null
  mediaMime: string | null
  pushName: string | null
  /** Jid con teléfono real cuando el payload es @lid y la trae (senderPn/remoteJidAlt). */
  lidPhoneJid: string | null
}

type BaileysMessage = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function localPhone(jid: string): string | null {
  const local = jid.split('@')[0] ?? ''
  return parseLoosePhone(local)
}

function altJidToPhone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.includes('@')) return null
  return localPhone(value)
}

/** senderPn/remoteJidAlt han llegado en el data y dentro del key según versión. */
function extractLidPhone(data: Record<string, unknown>, key: Record<string, unknown>): string | null {
  const candidates = [data.senderPn, data.remoteJidAlt, key.senderPn, key.remoteJidAlt]
  for (const candidate of candidates) {
    const phone = altJidToPhone(candidate)
    if (phone) return phone
  }
  return null
}

const TYPE_BY_CONTENT: Array<[string, MsgType]> = [
  ['conversation', 'text'],
  ['extendedTextMessage', 'text'],
  ['audioMessage', 'audio'],
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
]

function parseUpsert(data: Record<string, unknown>): ParsedUpsert | { ignore: string } {
  const key = isRecord(data.key) ? data.key : {}
  const jid = typeof key.remoteJid === 'string' ? key.remoteJid : ''
  if (!jid) return { ignore: 'payload sin remoteJid' }
  if (jid.endsWith('@g.us')) return { ignore: 'mensaje de grupo' }
  if (jid === 'status@broadcast') return { ignore: 'status@broadcast' }

  const message = isRecord(data.message) ? data.message : {}
  const messageType = typeof data.messageType === 'string' ? data.messageType : ''
  const contentTypes = Object.keys(message)

  // edición y reacción llegan como upsert con el tipo adentro del message;
  // están declaradas fuera de v1 y se ignoran
  if (messageType.includes('edit') || contentTypes.includes('editedMessage')) {
    return { ignore: 'edición de mensaje (fuera de v1)' }
  }
  if (messageType === 'reactionMessage' || contentTypes.includes('reactionMessage')) {
    return { ignore: 'reacción (fuera de v1)' }
  }
  if (messageType === 'protocolMessage' || contentTypes.includes('protocolMessage')) {
    return { ignore: 'protocolMessage' }
  }
  if (contentTypes.length === 0 && !messageType) return { ignore: 'payload sin message' }

  const fromMe = key.fromMe === true
  const id = typeof key.id === 'string' && key.id ? key.id : null

  const ts = Number(data.messageTimestamp)
  const sentAt = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date()

  let type: MsgType = 'other'
  if (messageType) {
    const mapped = TYPE_BY_CONTENT.find(([content]) => content === messageType)
    if (mapped) type = mapped[1]
  } else {
    const mapped = TYPE_BY_CONTENT.find(([content]) => contentTypes.includes(content))
    if (mapped) type = mapped[1]
  }

  const body =
    typeof message.conversation === 'string'
      ? message.conversation
      : isRecord(message.extendedTextMessage) && typeof message.extendedTextMessage.text === 'string'
        ? message.extendedTextMessage.text
        : null

  // el mimetype vive dentro del bloque de cada tipo de medio
  let mediaMime: string | null = null
  if (type !== 'text') {
    const block = message[messageType ?? ''] ?? message[contentTypes[0] ?? '']
    if (isRecord(block) && typeof block.mimetype === 'string') mediaMime = block.mimetype
  }

  return {
    jid,
    fromMe,
    externalId: id,
    sentAt,
    type,
    body,
    mediaMime,
    pushName: typeof data.pushName === 'string' && data.pushName ? data.pushName : null,
    lidPhoneJid: jid.endsWith('@lid') ? extractLidPhone(data, key) : null,
  }
}

async function ensureContact(
  db: Db,
  userId: string,
  jid: string,
  opts: { phone: string | null; isLid: boolean; pushName: string | null },
) {
  const existing = (
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.waJid, jid)))
      .limit(1)
  )[0]
  if (existing) {
    // el pushName llega con cada mensaje; solo rellena si estaba vacío
    if (opts.pushName && !existing.waName) {
      await db.update(contacts).set({ waName: opts.pushName }).where(eq(contacts.id, existing.id))
      existing.waName = opts.pushName
    }
    return existing
  }
  const inserted = await db
    .insert(contacts)
    .values({
      userId,
      waJid: jid,
      phoneE164: opts.phone,
      isLid: opts.isLid,
      waName: opts.pushName,
    })
    .onConflictDoNothing()
    .returning()
  if (inserted[0]) return inserted[0]
  // carrera sobre (user_id, wa_jid): la fila la creó otro handler del mismo retry
  return (
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.waJid, jid)))
      .limit(1)
  )[0]!
}

async function ensureConversation(db: Db, userId: string, jid: string, contactId: string) {
  const existing = (
    await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.waJid, jid)))
      .limit(1)
  )[0]
  if (existing) {
    // merge LID: la conversación del @lid apunta al contacto canónico
    if (existing.contactId !== contactId) {
      await db.update(conversations).set({ contactId }).where(eq(conversations.id, existing.id))
      existing.contactId = contactId
    }
    return existing
  }
  const inserted = await db
    .insert(conversations)
    .values({ userId, contactId, waJid: jid })
    .onConflictDoNothing()
    .returning()
  if (inserted[0]) return inserted[0]
  return (
    await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.waJid, jid)))
      .limit(1)
  )[0]!
}

export async function ingestMessage(
  db: Db,
  userId: string,
  payload: unknown,
): Promise<IngestResult> {
  if (!isRecord(payload)) return { inserted: false, ignored: 'payload malformado' }
  const parsed = parseUpsert(payload)
  if ('ignore' in parsed) {
    console.log(`[ingest] ignorado: ${parsed.ignore} (user ${userId})`)
    return { inserted: false, ignored: parsed.ignore }
  }

  // contacto: un @lid con teléfono conocido busca el canónico por phone_e164
  // y se marca fusionado hacia él
  let contactId: string
  if (parsed.lidPhoneJid) {
    const canonical = (
      await db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.userId, userId),
            eq(contacts.phoneE164, parsed.lidPhoneJid),
            eq(contacts.isLid, false),
            isNull(contacts.mergedIntoContactId),
          ),
        )
        .limit(1)
    )[0]
    const lidRow = await ensureContact(db, userId, parsed.jid, {
      phone: parsed.lidPhoneJid,
      isLid: true,
      pushName: parsed.pushName,
    })
    if (canonical) {
      if (lidRow.mergedIntoContactId !== canonical.id) {
        await db
          .update(contacts)
          .set({ mergedIntoContactId: canonical.id })
          .where(eq(contacts.id, lidRow.id))
      }
      contactId = canonical.id
    } else {
      // trae teléfono pero aún no existe el canónico: la fila LID guarda el
      // teléfono para fusionar cuando aparezca
      contactId = lidRow.id
    }
  } else {
    const row = await ensureContact(db, userId, parsed.jid, {
      phone: localPhone(parsed.jid),
      isLid: parsed.jid.endsWith('@lid'),
      pushName: parsed.pushName,
    })
    contactId = row.id
  }

  const conversation = await ensureConversation(db, userId, parsed.jid, contactId)

  const inserted = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      userId,
      externalId: parsed.externalId,
      direction: parsed.fromMe ? 'out' : 'in',
      type: parsed.type,
      body: parsed.body,
      mediaMime: parsed.mediaMime,
      sentAt: parsed.sentAt,
      // el payload completo permite rellenar luego (p.ej. LID sin teléfono)
      raw: payload,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id })

  // last_message_at solo avanza: los mensajes offline llegan desordenados
  const next =
    conversation.lastMessageAt && conversation.lastMessageAt > parsed.sentAt
      ? conversation.lastMessageAt
      : parsed.sentAt
  if (next !== conversation.lastMessageAt) {
    await db
      .update(conversations)
      .set({ lastMessageAt: next })
      .where(eq(conversations.id, conversation.id))
  }

  return { inserted: Boolean(inserted[0]) }
}

/** Conteo de no-leídos por conversación, sobre el índice parcial. */
export function unreadCountExpr() {
  return sql<number>`(
    select count(*)::int from messages m
    where m.conversation_id = ${conversations.id}
      and m.direction = 'in'
      and m.read_at is null
  )`
}
