import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const tstz = (name: string) => timestamp(name, { withTimezone: true })

// ---------- enums ----------

export const userStatusEnum = pgEnum('user_status', [
  'pending_verification',
  'pending_approval',
  'approved',
  'rejected',
  'suspended',
])

export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])

export const verificationChannelEnum = pgEnum('verification_channel', ['email', 'sms'])

export const verificationPurposeEnum = pgEnum('verification_purpose', [
  'signup_email',
  'signup_phone',
  'login',
  'password_reset',
  'email_change',
])

export const waStateEnum = pgEnum('wa_state', [
  'connecting',
  'connected',
  'disconnected',
  'logged_out',
])

export const msgDirectionEnum = pgEnum('msg_direction', ['in', 'out'])

export const msgTypeEnum = pgEnum('msg_type', [
  'text',
  'audio',
  'image',
  'video',
  'document',
  'sticker',
  'other',
])

export const transcriptStatusEnum = pgEnum('transcript_status', ['none', 'pending', 'done', 'error'])

export const taskKindEnum = pgEnum('task_kind', [
  'contacts_sync',
  'summarize',
  'contacts_export',
  'birthday_import',
  'birthday_calendar_sync',
])

export const taskStatusEnum = pgEnum('task_status', ['queued', 'running', 'done', 'error'])

export const birthdaySourceEnum = pgEnum('birthday_source', ['google', 'manual'])

// ---------- tablas ----------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(), // E.164
  email: text('email').notNull().unique(), // siempre lowercase
  passwordHash: text('password_hash').notNull(), // scrypt salt:hash
  role: userRoleEnum('role').notNull().default('user'),
  status: userStatusEnum('status').notNull().default('pending_verification'),
  emailVerifiedAt: tstz('email_verified_at'),
  phoneVerifiedAt: tstz('phone_verified_at'),
  approvedAt: tstz('approved_at'),
  approvedBy: uuid('approved_by').references((): AnyPgColumn => users.id),
  rejectedReason: text('rejected_reason'),
})

export const verificationCodes = pgTable(
  'verification_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    channel: verificationChannelEnum('channel').notNull(),
    purpose: verificationPurposeEnum('purpose').notNull(),
    // null cuando el canal es sms con driver twilio: la verificación vive allá,
    // la fila local solo da rate limiting
    codeHash: text('code_hash'),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    // "emitir invalida los anteriores del mismo (channel, purpose)"
    index('verification_codes_user_channel_purpose_idx').on(t.userId, t.channel, t.purpose),
  ],
)

export const trustedDevices = pgTable(
  'trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(), // sha256 del token de la cookie wp_trusted
    userAgent: text('user_agent'),
    lastUsedAt: tstz('last_used_at'),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [index('trusted_devices_user_idx').on(t.userId)],
)

export const waInstances = pgTable('wa_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique().references(() => users.id),
  instanceName: text('instance_name').notNull().unique(), // u_ + uuid sin guiones
  state: waStateEnum('state').notNull().default('connecting'),
  connectedJid: text('connected_jid'),
  lastStateAt: tstz('last_state_at'),
})

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    waJid: text('wa_jid').notNull(),
    phoneE164: text('phone_e164'),
    isLid: boolean('is_lid').notNull().default(false),
    // merge LID: apunta al contacto canónico que sí tiene teléfono
    mergedIntoContactId: uuid('merged_into_contact_id').references((): AnyPgColumn => contacts.id),
    displayName: text('display_name'),
    waName: text('wa_name'),
    birthMonth: integer('birth_month'),
    birthDay: integer('birth_day'),
    birthYear: integer('birth_year'),
    birthdaySource: birthdaySourceEnum('birthday_source'),
    googleResourceName: text('google_resource_name'),
  },
  (t) => [
    uniqueIndex('contacts_user_jid_uq').on(t.userId, t.waJid),
    // el import de cumpleaños matchea por teléfono contra canónicos
    index('contacts_user_phone_idx').on(t.userId, t.phoneE164),
  ],
)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    waJid: text('wa_jid').notNull(),
    lastMessageAt: tstz('last_message_at'),
    summary: text('summary'),
    summaryModel: text('summary_model'),
    summaryUpdatedAt: tstz('summary_updated_at'),
    // watermark por reloj de inserción de la DB: los key.id de WhatsApp no ordenan
    // y los mensajes offline llegan tarde
    summaryThruCreatedAt: tstz('summary_thru_created_at'),
  },
  (t) => [
    uniqueIndex('conversations_user_jid_uq').on(t.userId, t.waJid),
    index('conversations_user_last_message_idx').on(t.userId, t.lastMessageAt),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
    // denormalizado: toda query de inbox filtra user_id sin join
    userId: uuid('user_id').notNull().references(() => users.id),
    externalId: text('external_id'), // key.id de WhatsApp; también mediaId
    direction: msgDirectionEnum('direction').notNull(),
    type: msgTypeEnum('type').notNull().default('text'),
    body: text('body'),
    mediaMime: text('media_mime'),
    readAt: tstz('read_at'),
    transcript: text('transcript'),
    transcriptStatus: transcriptStatusEnum('transcript_status').notNull().default('none'),
    transcriptModel: text('transcript_model'),
    // set al marcar pending; lo usa el reaper para detectar transcripciones
    // colgadas (>10 min) sin depender de created_at, que es la llegada del
    // audio y puede ser muy anterior a cuando se pidió transcribirlo
    transcribeStartedAt: tstz('transcribe_started_at'),
    transcribedAt: tstz('transcribed_at'),
    sentAt: tstz('sent_at').notNull(), // timestamp del mensaje según WhatsApp
    createdAt: tstz('created_at').notNull().defaultNow(), // inserción: base del watermark
    raw: jsonb('raw'), // payload original para backfill (LID sin teléfono, etc.)
  },
  (t) => [
    // dedup por key.id; retries de webhook inocuos. Parcial: external_id nullable
    uniqueIndex('messages_conversation_external_uq')
      .on(t.conversationId, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    // paginación keyset del inbox
    index('messages_keyset_idx').on(t.conversationId, t.sentAt.desc(), t.id),
    // conteo de no-leídos por conversación
    index('messages_unread_idx')
      .on(t.conversationId)
      .where(sql`direction = 'in' AND read_at IS NULL`),
  ],
)

export const googleAccounts = pgTable('google_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique().references(() => users.id),
  googleEmail: text('google_email').notNull(),
  refreshTokenEnc: text('refresh_token_enc').notNull(), // AES-256-GCM con ENCRYPTION_KEY
  scopes: text('scopes').notNull(), // lista separada por espacios
  peopleSyncToken: text('people_sync_token'),
  connectedAt: tstz('connected_at').notNull().defaultNow(),
  revokedAt: tstz('revoked_at'),
})

export const birthdayEvents = pgTable(
  'birthday_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    contactId: uuid('contact_id').notNull().references(() => contacts.id),
    googleEventId: text('google_event_id'),
    calendarId: text('calendar_id').notNull().default('primary'),
    lastVerifiedAt: tstz('last_verified_at'),
  },
  (t) => [uniqueIndex('birthday_events_user_contact_uq').on(t.userId, t.contactId)],
)

export const taskRuns = pgTable(
  'task_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    kind: taskKindEnum('kind').notNull(),
    status: taskStatusEnum('status').notNull().default('queued'),
    processed: integer('processed').notNull().default(0),
    total: integer('total').notNull().default(0),
    filePath: text('file_path'),
    error: text('error'),
    params: jsonb('params'),
    bullmqJobId: text('bullmq_job_id'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    index('task_runs_user_idx').on(t.userId),
    // el reaper busca running estancados por updated_at
    index('task_runs_status_updated_idx').on(t.status, t.updatedAt),
  ],
)
