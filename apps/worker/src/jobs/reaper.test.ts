import { chmod, mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { closeClient, contacts, conversations, getDb, messages, taskRuns, users, type Db } from '@wp/db'
import { sweepOldExports, sweepStuckTaskRuns, sweepStuckTranscriptions } from './reaper.js'

/**
 * sweepStuckTranscriptions/sweepStuckTaskRuns/sweepOldExports contra el
 * postgres real, mismo patrón que transcribe.test.ts: nada de esto arranca
 * el worker (Redis, BullMQ, health server), así que "task_run interrumpido
 * barrido por el reaper" queda reproducible por el revisor y no solo prosa
 * del reporte.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`

let db: Db
let userId: string
let conversationId: string
let staleMsgId: string
let freshMsgId: string
let freshMsgId2: string
const suiteUserIds: string[] = []

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-reaper.${RUN}@mail.test`,
      phone: `+57301${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)

  const [contact] = await db
    .insert(contacts)
    .values({ userId, waJid: '573002223344@s.whatsapp.net', displayName: 'Prueba reaper' })
    .returning()
  const [conv] = await db
    .insert(conversations)
    .values({ userId, contactId: contact!.id, waJid: contact!.waJid, lastMessageAt: new Date() })
    .returning()
  conversationId = conv!.id

  const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000)
  const oneMinuteAgo = new Date(Date.now() - 60_000)

  const [stale] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-STALE-${RUN}`,
      direction: 'in',
      type: 'audio',
      transcriptStatus: 'pending',
      transcribeStartedAt: elevenMinutesAgo,
      sentAt: elevenMinutesAgo,
    })
    .returning()
  staleMsgId = stale!.id

  const [fresh] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-FRESH-${RUN}`,
      direction: 'in',
      type: 'audio',
      transcriptStatus: 'pending',
      transcribeStartedAt: oneMinuteAgo,
      sentAt: oneMinuteAgo,
    })
    .returning()
  freshMsgId = fresh!.id

  const [fresh2] = await db
    .insert(messages)
    .values({
      conversationId,
      userId,
      externalId: `EXT-FRESH2-${RUN}`,
      direction: 'in',
      type: 'audio',
      transcriptStatus: 'pending',
      transcribeStartedAt: oneMinuteAgo,
      sentAt: oneMinuteAgo,
    })
    .returning()
  freshMsgId2 = fresh2!.id
})

afterAll(async () => {
  await db.delete(taskRuns).where(inArray(taskRuns.userId, suiteUserIds)).catch(() => {})
  await db.delete(messages).where(inArray(messages.userId, suiteUserIds)).catch(() => {})
  await db.delete(conversations).where(inArray(conversations.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

describe('sweepStuckTranscriptions', () => {
  // el barrido se acota a la conversación de esta suite: el UPDATE de
  // producción barre la tabla entera y sin el acote este test podría marcar
  // como error mensajes pending de otra suite corriendo a la vez (hoy
  // secuencial, pero el acote lo vuelve inocuo ante cualquier cambio)
  it('pending colgado hace 11 minutos (umbral 10 min): queda en error', async () => {
    const touched = await sweepStuckTranscriptions(db, 10 * 60_000, conversationId)
    expect(touched).toBeGreaterThanOrEqual(1)
    const row = (await db.select().from(messages).where(eq(messages.id, staleMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('error')
  })

  it('pending reciente hace 1 minuto (umbral 10 min): sigue en pending', async () => {
    await sweepStuckTranscriptions(db, 10 * 60_000, conversationId)
    const row = (await db.select().from(messages).where(eq(messages.id, freshMsgId)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('pending')
  })

  it('umbral explícito de 30s: un mensaje de hace 1 minuto también cae', async () => {
    const touched = await sweepStuckTranscriptions(db, 30_000, conversationId)
    expect(touched).toBeGreaterThanOrEqual(1)
    const row = (await db.select().from(messages).where(eq(messages.id, freshMsgId2)).limit(1))[0]!
    expect(row.transcriptStatus).toBe('error')
  })
})

describe('sweepStuckTaskRuns', () => {
  // el barrido se acota al usuario de esta suite, igual que el de
  // transcripciones: el SELECT de producción barre toda la tabla de
  // task_runs y sin el acote este test podría tocar filas 'running' de otra
  // suite corriendo a la vez. Dentro del archivo el orden sigue importando:
  // la fila "activo, no se toca" del último test queda 'running' a propósito
  // (el reaper la resuelve cuando el job real termine) y ensuciaría el
  // "touched" de un test que corriera después.
  it('running reciente (updated_at fresco): no cae aunque isActiveJob diga que no', async () => {
    const [row] = await db
      .insert(taskRuns)
      .values({ userId, kind: 'contacts_export', status: 'running', bullmqJobId: 'job-fresh' })
      .returning()
    const touched = await sweepStuckTaskRuns(db, 15 * 60_000, async () => false, userId)
    expect(touched).toBe(0)
    const after = (await db.select().from(taskRuns).where(eq(taskRuns.id, row!.id)).limit(1))[0]!
    expect(after.status).toBe('running')
  })

  it('running estancado (updated_at viejo) sin job activo: interrumpido', async () => {
    const [row] = await db
      .insert(taskRuns)
      .values({ userId, kind: 'contacts_sync', status: 'running', bullmqJobId: 'job-stuck' })
      .returning()
    await db
      .update(taskRuns)
      .set({ updatedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(taskRuns.id, row!.id))

    const touched = await sweepStuckTaskRuns(db, 15 * 60_000, async () => false, userId)
    expect(touched).toBe(1)
    const after = (await db.select().from(taskRuns).where(eq(taskRuns.id, row!.id)).limit(1))[0]!
    expect(after.status).toBe('error')
    expect(after.error).toBe('interrumpido')
    expect(after.finishedAt).not.toBeNull()
  })

  it('running estancado pero con job activo en BullMQ: no se toca (deja una fila running a propósito)', async () => {
    const [row] = await db
      .insert(taskRuns)
      .values({ userId, kind: 'summarize', status: 'running', bullmqJobId: 'job-alive' })
      .returning()
    await db
      .update(taskRuns)
      .set({ updatedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(taskRuns.id, row!.id))

    const touched = await sweepStuckTaskRuns(db, 15 * 60_000, async (id) => id === 'job-alive', userId)
    expect(touched).toBe(0)
    const after = (await db.select().from(taskRuns).where(eq(taskRuns.id, row!.id)).limit(1))[0]!
    expect(after.status).toBe('running')
  })
})

describe('sweepOldExports', () => {
  let exportDir: string

  afterEach(async () => {
    if (exportDir) await rm(exportDir, { recursive: true, force: true }).catch(() => {})
  })

  it('borra el archivo viejo y limpia file_path; deja intacto el reciente', async () => {
    exportDir = await mkdtemp(path.join(tmpdir(), 'wp-export-'))
    const userDir = path.join(exportDir, userId)
    await mkdir(userDir, { recursive: true })

    const oldFile = path.join(userDir, 'old.xlsx')
    const freshFile = path.join(userDir, 'fresh.xlsx')
    await writeFile(oldFile, 'contenido viejo')
    await writeFile(freshFile, 'contenido reciente')
    const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await utimes(oldFile, oldTime, oldTime)

    const [oldRow] = await db
      .insert(taskRuns)
      .values({ userId, kind: 'contacts_export', status: 'done', filePath: oldFile })
      .returning()
    const [freshRow] = await db
      .insert(taskRuns)
      .values({ userId, kind: 'contacts_export', status: 'done', filePath: freshFile })
      .returning()

    const removed = await sweepOldExports(db, exportDir, 30 * 24 * 60 * 60 * 1000)
    expect(removed).toBe(1)

    await expect(stat(oldFile)).rejects.toThrow()
    await expect(stat(freshFile)).resolves.toBeDefined()

    const oldAfter = (await db.select().from(taskRuns).where(eq(taskRuns.id, oldRow!.id)).limit(1))[0]!
    expect(oldAfter.filePath).toBeNull()
    const freshAfter = (await db.select().from(taskRuns).where(eq(taskRuns.id, freshRow!.id)).limit(1))[0]!
    expect(freshAfter.filePath).toBe(freshFile)
  })

  it('file_path que ya no existe en disco: se limpia igual (disco borrado a mano)', async () => {
    exportDir = await mkdtemp(path.join(tmpdir(), 'wp-export-'))
    const [row] = await db
      .insert(taskRuns)
      .values({ userId, kind: 'contacts_export', status: 'done', filePath: path.join(exportDir, userId, 'fantasma.xlsx') })
      .returning()

    const removed = await sweepOldExports(db, exportDir, 30 * 24 * 60 * 60 * 1000)
    expect(removed).toBe(0)
    const after = (await db.select().from(taskRuns).where(eq(taskRuns.id, row!.id)).limit(1))[0]!
    expect(after.filePath).toBeNull()
  })

  it('archivo inaccesible por permisos no se trata como inexistente: file_path queda', async () => {
    exportDir = await mkdtemp(path.join(tmpdir(), 'wp-export-'))
    const lockedDir = path.join(exportDir, `${userId}-locked`)
    await mkdir(lockedDir, { recursive: true })
    const lockedFile = path.join(lockedDir, 'viejo.xlsx')
    await writeFile(lockedFile, 'contenido viejo')
    const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await utimes(lockedFile, oldTime, oldTime)
    await chmod(lockedDir, 0o000) // stat del archivo de adentro da EACCES

    try {
      const [row] = await db
        .insert(taskRuns)
        .values({ userId, kind: 'contacts_export', status: 'done', filePath: lockedFile })
        .returning()

      const removed = await sweepOldExports(db, exportDir, 30 * 24 * 60 * 60 * 1000)
      expect(removed).toBe(0)
      const after = (await db.select().from(taskRuns).where(eq(taskRuns.id, row!.id)).limit(1))[0]!
      expect(after.filePath).toBe(lockedFile)
    } finally {
      await chmod(lockedDir, 0o755) // sin esto, rm -r del afterEach también falla
    }
  })
})
