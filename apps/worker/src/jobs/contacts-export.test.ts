import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { eq, inArray } from 'drizzle-orm'
import { closeClient, contacts, conversations, getDb, messages, taskRuns, users, type Db } from '@wp/db'
import type { LlmClient } from '@wp/llm'
import { conversationIdForContact, formatBirthday, runContactsExport } from './contacts-export.js'

/**
 * contacts_export contra el postgres real: el criterio de aceptación es que
 * el xlsx resultante se pueda abrir y traiga las cuatro columnas
 * (Nombre/Teléfono/Cumpleaños/Resumen), con progreso real en task_runs.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`

let db: Db
let userId: string
const suiteUserIds: string[] = []

function fakeLlm(text: string): LlmClient {
  return {
    config: () => ({ provider: 'local', baseUrl: 'http://llm.test', model: 'test-model' }),
    async generate() {
      return { text, inputTokens: 10, outputTokens: 5, model: 'test-model' }
    },
  }
}

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-export.${RUN}@mail.test`,
      phone: `+57306${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)
})

afterAll(async () => {
  await db.delete(taskRuns).where(inArray(taskRuns.userId, suiteUserIds)).catch(() => {})
  await db.delete(messages).where(inArray(messages.userId, suiteUserIds)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

describe('formatBirthday', () => {
  it('con año: AAAA-MM-DD; sin año: MM-DD; sin mes o día: null', () => {
    expect(formatBirthday(3, 5, 1990)).toBe('1990-03-05')
    expect(formatBirthday(12, 25, null)).toBe('12-25')
    expect(formatBirthday(null, 25, 1990)).toBeNull()
  })
})

describe('runContactsExport', () => {
  let exportDir: string

  afterEach(async () => {
    if (exportDir) await rm(exportDir, { recursive: true, force: true }).catch(() => {})
  })

  it('xlsx generado y legible: cuatro columnas, sin resúmenes cuando includeSummaries=false', async () => {
    exportDir = await mkdtemp(path.join(tmpdir(), 'wp-export-'))

    await db
      .insert(contacts)
      .values({
        userId,
        waJid: '573007770001@s.whatsapp.net',
        displayName: 'Ana Cumpleañera',
        phoneE164: '+573007770001',
        birthMonth: 4,
        birthDay: 20,
        birthYear: 1992,
      })
      .returning()
    const [merged] = await db
      .insert(contacts)
      .values({ userId, waJid: '573007770099@lid', displayName: 'Fusionado', isLid: true })
      .returning()
    await db
      .insert(contacts)
      .values({
        userId,
        waJid: '573007770098@lid',
        displayName: 'No debería salir',
        isLid: true,
        mergedIntoContactId: merged!.id,
      })

    const [taskRun] = await db.insert(taskRuns).values({ userId, kind: 'contacts_export', status: 'queued' }).returning()

    const result = await runContactsExport(userId, taskRun!.id, false, { db, exportDir })
    expect(result.rows).toBeGreaterThanOrEqual(2)
    expect(result.summariesGenerated).toBe(0)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(result.filePath)
    const sheet = workbook.getWorksheet('Contactos')!
    const header = sheet.getRow(1).values as unknown[]
    expect(header.slice(1)).toEqual(['Nombre', 'Teléfono', 'Cumpleaños', 'Resumen'])

    const rows: string[] = []
    sheet.eachRow((row, num) => {
      if (num === 1) return
      rows.push(String(row.getCell(1).value))
    })
    expect(rows).toContain('Ana Cumpleañera')
    expect(rows).not.toContain('No debería salir')

    // la fila de Ana trae su cumpleaños formateado; se busca por nombre
    // porque el orden alfabético de la hoja no está garantizado en el test
    let anaBirthday: unknown
    sheet.eachRow((row) => {
      if (row.getCell(1).value === 'Ana Cumpleañera') anaBirthday = row.getCell(3).value
    })
    expect(anaBirthday).toBe('1992-04-20')

    const task = (await db.select().from(taskRuns).where(eq(taskRuns.id, taskRun!.id)).limit(1))[0]!
    expect(task.status).toBe('done')
    expect(task.filePath).toBe(result.filePath)
    expect(task.processed).toBe(task.total)
  })

  it('la columna Cumpleaños refleja lo importado de Google (sin año incluido) y lo manual tal cual', async () => {
    exportDir = await mkdtemp(path.join(tmpdir(), 'wp-export-'))

    await db.insert(contacts).values([
      {
        userId,
        waJid: '573007770101@s.whatsapp.net',
        displayName: 'Importado de Google',
        phoneE164: '+573007770101',
        birthMonth: 12,
        birthDay: 24,
        birthYear: null, // Google entrega muchos cumpleaños sin año
        birthdaySource: 'google',
      },
      {
        userId,
        waJid: '573007770102@s.whatsapp.net',
        displayName: 'Editado a Mano',
        phoneE164: '+573007770102',
        birthMonth: 7,
        birthDay: 1,
        birthYear: 1980,
        birthdaySource: 'manual',
      },
    ])

    const [taskRun] = await db.insert(taskRuns).values({ userId, kind: 'contacts_export', status: 'queued' }).returning()
    const result = await runContactsExport(userId, taskRun!.id, false, { db, exportDir })

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(result.filePath)
    const sheet = workbook.getWorksheet('Contactos')!
    const birthdayOf = (name: string): unknown => {
      let found: unknown
      sheet.eachRow((row) => {
        if (row.getCell(1).value === name) found = row.getCell(3).value
      })
      return found
    }
    expect(birthdayOf('Importado de Google')).toBe('12-24')
    expect(birthdayOf('Editado a Mano')).toBe('1980-07-01')
  })

  it('includeSummaries=true: genera el resumen inline y actualiza processed en cada contacto', async () => {
    exportDir = await mkdtemp(path.join(tmpdir(), 'wp-export-'))

    const [contact] = await db
      .insert(contacts)
      .values({ userId, waJid: '573007770002@s.whatsapp.net', displayName: 'Con conversación' })
      .returning()
    const [conv] = await db
      .insert(conversations)
      .values({ userId, contactId: contact!.id, waJid: contact!.waJid })
      .returning()
    await db.insert(messages).values({
      conversationId: conv!.id,
      userId,
      externalId: `EXP-MSG-${RUN}`,
      direction: 'in',
      type: 'text',
      body: 'hola, exportame',
      sentAt: new Date(),
    })

    const [taskRun] = await db.insert(taskRuns).values({ userId, kind: 'contacts_export', status: 'queued' }).returning()

    const result = await runContactsExport(userId, taskRun!.id, true, {
      db,
      exportDir,
      llm: fakeLlm('resumen para el export'),
      evolution: null,
    })
    expect(result.summariesGenerated).toBeGreaterThanOrEqual(1)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(result.filePath)
    const sheet = workbook.getWorksheet('Contactos')!
    let found = false
    sheet.eachRow((row) => {
      if (row.getCell(1).value === 'Con conversación') {
        expect(row.getCell(4).value).toBe('resumen para el export')
        found = true
      }
    })
    expect(found).toBe(true)

    const conv2 = (await db.select().from(conversations).where(eq(conversations.id, conv!.id)).limit(1))[0]!
    expect(conv2.summary).toBe('resumen para el export')
  })
})

describe('conversationIdForContact', () => {
  it('prefiere la conversación con el propio wa_jid del contacto', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ userId, waJid: '573007770003@s.whatsapp.net', displayName: 'Con jid propio' })
      .returning()
    const [conv] = await db
      .insert(conversations)
      .values({ userId, contactId: contact!.id, waJid: contact!.waJid })
      .returning()
    const found = await conversationIdForContact(db, userId, contact!)
    expect(found).toBe(conv!.id)
  })

  it('sin conversación: null', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ userId, waJid: '573007770004@s.whatsapp.net', displayName: 'Sin conversación' })
      .returning()
    const found = await conversationIdForContact(db, userId, contact!)
    expect(found).toBeNull()
  })
})
