import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { closeClient, getDb, taskRuns, users, type Db } from '@wp/db'
import { closeRedis, getRedis } from '../redis.js'
import { buildApp } from '../app.js'
import { readEnv } from '../env.js'
import { RUN, createDirectUser, inject, mail, phone, sessionCookie } from '../test-support.js'

/**
 * task_runs: lista, detalle y descarga. El criterio de aceptación de esta
 * fase es literal: que el usuario B no pueda descargar el archivo de A.
 */

let app: FastifyInstance
let db: Db
let cookieA: string
let cookieB: string
let userIdA: string
let userIdB: string
let doneTaskId: string
let runningTaskId: string
let exportDir: string
const suiteUsers: string[] = []

beforeAll(async () => {
  db = getDb()
  getRedis()
  const env = { ...readEnv(), jwtSecret: `test-tasks-${RUN}-secret` }
  app = await buildApp({ env })

  const userA = await createDirectUser(db, { email: mail('tasksA'), phone: phone(30) })
  const userB = await createDirectUser(db, { email: mail('tasksB'), phone: phone(31) })
  userIdA = userA.id
  userIdB = userB.id
  suiteUsers.push(userIdA, userIdB)
  cookieA = await sessionCookie(env.jwtSecret, userIdA)
  cookieB = await sessionCookie(env.jwtSecret, userIdB)

  exportDir = await mkdtemp(path.join(tmpdir(), 'wp-api-export-'))
  const filePath = path.join(exportDir, 'contactos-de-A.xlsx')
  await writeFile(filePath, 'contenido-xlsx-de-prueba')

  const [done] = await db
    .insert(taskRuns)
    .values({
      userId: userIdA,
      kind: 'contacts_export',
      status: 'done',
      processed: 3,
      total: 3,
      filePath,
      finishedAt: new Date(),
    })
    .returning()
  doneTaskId = done!.id

  const [running] = await db
    .insert(taskRuns)
    .values({ userId: userIdA, kind: 'contacts_sync', status: 'running', processed: 1, total: 2 })
    .returning()
  runningTaskId = running!.id
})

afterAll(async () => {
  await db.delete(taskRuns).where(inArray(taskRuns.userId, suiteUsers)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUsers)).catch(() => {})
  await rm(exportDir, { recursive: true, force: true }).catch(() => {})
  await app.close()
  await closeRedis()
  await closeClient()
})

describe('GET /tasks', () => {
  it('sin sesión: 401', async () => {
    const res = await inject(app, 'GET', '/tasks')
    expect(res.status).toBe(401)
  })

  it('solo trae las tareas del usuario dueño de la sesión', async () => {
    const res = await inject(app, 'GET', '/tasks', { cookie: cookieA })
    expect(res.status).toBe(200)
    const ids = res.body.items.map((t: { id: string }) => t.id)
    expect(ids).toContain(doneTaskId)
    expect(ids).toContain(runningTaskId)

    const resB = await inject(app, 'GET', '/tasks', { cookie: cookieB })
    expect(resB.body.items.map((t: { id: string }) => t.id)).not.toContain(doneTaskId)
  })
})

describe('GET /tasks/:id', () => {
  it('aislamiento: userB pide la tarea de userA y recibe 404', async () => {
    const res = await inject(app, 'GET', `/tasks/${doneTaskId}`, { cookie: cookieB })
    expect(res.status).toBe(404)
  })

  it('el dueño ve el progreso real', async () => {
    const res = await inject(app, 'GET', `/tasks/${runningTaskId}`, { cookie: cookieA })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('running')
    expect(res.body.processed).toBe(1)
    expect(res.body.total).toBe(2)
  })
})

describe('GET /tasks/:id/download', () => {
  it('sin sesión: 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/tasks/${doneTaskId}/download` })
    expect(res.statusCode).toBe(401)
  })

  it('EL CASO DE ACEPTACIÓN: userB no puede descargar el archivo de userA (404, no el archivo)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${doneTaskId}/download`,
      headers: { cookie: cookieB, 'x-forwarded-for': '10.60.0.1' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('contenido-xlsx-de-prueba')
  })

  it('tarea sin archivo (running): 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${runningTaskId}/download`,
      headers: { cookie: cookieA, 'x-forwarded-for': '10.60.0.2' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('el dueño descarga el archivo con el content-type de xlsx', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${doneTaskId}/download`,
      headers: { cookie: cookieA, 'x-forwarded-for': '10.60.0.3' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.body).toBe('contenido-xlsx-de-prueba')
  })
})
