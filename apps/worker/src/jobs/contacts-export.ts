import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, eq, isNull } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { contacts, conversations, getDb, taskRuns, type Db } from '@wp/db'
import type { EvolutionClient } from '@wp/channels'
import type { LlmClient } from '@wp/llm'
import { summarizeConversation } from './summarize.js'

/**
 * Job contacts_export: arma el xlsx de contactos canónicos (Nombre, Teléfono,
 * Cumpleaños, Resumen) en {EXPORT_DIR}/{userId}/{taskRunId}.xlsx y deja la
 * ruta absoluta en task_runs.file_path para que la API lo sirva. Con
 * includeSummaries genera inline, uno por uno, los resúmenes que falten o
 * estén por debajo del umbral incremental, actualizando el progreso para
 * que la barra del panel sea real.
 */

export interface ContactExportRow {
  displayName: string
  phoneE164: string | null
  birthday: string | null
  summary: string | null
}

/** La conversación cuyo resumen representa al contacto: su propio jid, y si no, la más reciente. */
export async function conversationIdForContact(
  db: Db,
  userId: string,
  contact: { id: string; waJid: string },
): Promise<string | null> {
  const own = (
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.contactId, contact.id),
          eq(conversations.waJid, contact.waJid),
        ),
      )
      .limit(1)
  )[0]
  if (own) return own.id
  const any = (
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.contactId, contact.id)))
      .orderBy(asc(conversations.lastMessageAt))
      .limit(1)
  )[0]
  return any?.id ?? null
}

export function formatBirthday(m: number | null, d: number | null, y: number | null): string | null {
  if (!m || !d) return null
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return y ? `${y}-${mm}-${dd}` : `${mm}-${dd}`
}

export interface ContactsExportDeps {
  db?: Db
  exportDir?: string
  /** Inyectable para tests; por defecto el que construye summarizeConversation. */
  llm?: LlmClient
  evolution?: EvolutionClient | null
  /** Tope de tokens del resumen, inyectable para tests. */
  tokenCap?: number
}

export interface ContactsExportResult {
  filePath: string
  rows: number
  summariesGenerated: number
}

export async function runContactsExport(
  userId: string,
  taskRunId: string,
  includeSummaries: boolean,
  deps: ContactsExportDeps = {},
): Promise<ContactsExportResult> {
  const db = deps.db ?? getDb()
  const exportDir = deps.exportDir ?? './var/exports'

  await db
    .update(taskRuns)
    .set({ status: 'running', processed: 0, total: 0, updatedAt: new Date() })
    .where(eq(taskRuns.id, taskRunId))

  const canonical = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNull(contacts.mergedIntoContactId)))
    .orderBy(asc(contacts.displayName), asc(contacts.id))

  const total = canonical.length
  const touch = (processed: number) =>
    db.update(taskRuns).set({ processed, total, updatedAt: new Date() }).where(eq(taskRuns.id, taskRunId))

  let summariesGenerated = 0
  const rows: ContactExportRow[] = []

  try {
    for (const [index, contact] of canonical.entries()) {
      const conversationId = await conversationIdForContact(db, userId, contact)
      let summary: string | null = null
      if (conversationId) {
        if (includeSummaries) {
          const result = await summarizeConversation(
            userId,
            conversationId,
            {},
            {
              db,
              ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
              evolution: deps.evolution ?? null,
              ...(deps.tokenCap !== undefined ? { tokenCap: deps.tokenCap } : {}),
            },
          )
          if (result.status === 'done') summariesGenerated += 1
        }
        const conv = (
          await db
            .select({ summary: conversations.summary })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1)
        )[0]
        summary = conv?.summary ?? null
      }
      rows.push({
        displayName: contact.displayName ?? contact.waName ?? contact.waJid.split('@')[0] ?? contact.waJid,
        phoneE164: contact.phoneE164,
        birthday: formatBirthday(contact.birthMonth, contact.birthDay, contact.birthYear),
        summary,
      })
      if (includeSummaries) await touch(index + 1)
    }
    if (!includeSummaries) await touch(rows.length)

    const userDir = path.join(path.resolve(exportDir), userId)
    await mkdir(userDir, { recursive: true })
    const filePath = path.join(userDir, `${taskRunId}.xlsx`)

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Contactos')
    sheet.columns = [
      { header: 'Nombre', key: 'displayName', width: 32 },
      { header: 'Teléfono', key: 'phoneE164', width: 18 },
      { header: 'Cumpleaños', key: 'birthday', width: 12 },
      { header: 'Resumen', key: 'summary', width: 80 },
    ]
    for (const row of rows) sheet.addRow(row)
    await workbook.xlsx.writeFile(filePath)

    await db
      .update(taskRuns)
      .set({
        status: 'done',
        processed: rows.length,
        total,
        filePath,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(taskRuns.id, taskRunId))

    return { filePath, rows: rows.length, summariesGenerated }
  } catch (err) {
    // el archivo a medias no se sirve: la descarga solo existe con status done
    await db
      .update(taskRuns)
      .set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(taskRuns.id, taskRunId))
    throw err
  }
}
