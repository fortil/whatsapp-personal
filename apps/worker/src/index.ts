import http from 'node:http'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { closeClient, getDb, type Db } from '@wp/db'
import { createEvolutionClient, type EvolutionClient } from '@wp/channels'
import { handleTranscribeFailure } from './jobs/transcribe.js'
import { processJob } from './jobs/process-job.js'
import { runReaperSweep } from './jobs/reaper.js'
import { missingStartupEnv, readWorkerEnv } from './env.js'

/**
 * Arranque del worker: consumidor BullMQ de la cola 'tasks' (el mismo nombre
 * que produce apps/api/src/queues.ts), health liveness para el compose, y el
 * reaper periódico. attempts/backoff los fija el productor al encolar
 * (JOB_DEFAULTS en la API); aquí solo se procesa y se marca error cuando
 * BullMQ agota los reintentos. La lógica de cada pieza (dispatcher, handler
 * de 'failed', reaper) vive en ./jobs/ para poder probarla sin abrir Redis
 * ni bindear el puerto de health: este archivo solo cablea.
 */

const QUEUE_NAME = 'tasks'

const env = readWorkerEnv()
const missing = missingStartupEnv(env)
if (missing.length > 0) {
  throw new Error(`Faltan variables obligatorias: ${missing.join(', ')}. Copia .env.example a .env y llénala.`)
}

const db: Db = getDb()

const evolution: EvolutionClient | null =
  env.evolutionApiUrl && env.evolutionApiKey
    ? createEvolutionClient({ baseUrl: env.evolutionApiUrl, apiKey: env.evolutionApiKey })
    : null
if (!evolution) {
  console.error('[worker] EVOLUTION_API_URL/EVOLUTION_API_KEY ausentes: transcribe fallará con mensaje claro')
}

// BullMQ exige maxRetriesPerRequest: null en la conexión que usa
const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null })

const worker = new Worker(QUEUE_NAME, (job) => processJob(job, { db, evolution, exportDir: env.exportDir }), {
  connection,
})

worker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.name ?? '?'} (${job?.id ?? '?'}) falló:`, err.message)
  void handleTranscribeFailure(db, job, err).catch((e) =>
    console.error('[worker] no se pudo marcar error en el mensaje:', e instanceof Error ? e.message : e),
  )
})

worker.on('error', (err) => {
  console.error('[worker] error de conexión:', err.message)
})

// ---------- reaper ----------
// Los barridos viven en ./jobs/reaper.ts; aquí solo se agendan. Para no
// marcar "interrumpido" un task_run cuyo job sigue corriendo, el reaper
// consulta el estado real en BullMQ con una instancia de Queue productor
// sobre la misma conexión.

const reaperQueue = new Queue(QUEUE_NAME, { connection })

const isActiveJob = async (bullmqJobId: string): Promise<boolean> => {
  try {
    const job = await reaperQueue.getJob(bullmqJobId)
    if (!job) return false
    const state = await job.getState()
    return state === 'active' || state === 'waiting' || state === 'delayed' || state === 'waiting-children'
  } catch {
    // sin respuesta de redis mejor no tocar la fila en este ciclo
    return true
  }
}

const reaperTimer = setInterval(() => {
  void runReaperSweep(db, { exportDir: env.exportDir, isActiveJob }).catch((err) =>
    console.error('[worker] reaper falló:', err instanceof Error ? err.message : err),
  )
}, env.reaperIntervalMs)

// ---------- health liveness para el compose ----------

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  res.writeHead(404)
  res.end()
})
healthServer.listen(env.workerPort, () => {
  console.log(`[worker] health en http://localhost:${env.workerPort}/health`)
})

console.log(`[worker] escuchando la cola "${QUEUE_NAME}"`)

async function shutdown(signal: string): Promise<void> {
  console.log(`[${signal}] cerrando worker`)
  clearInterval(reaperTimer)
  await worker.close()
  await reaperQueue.close().catch(() => {})
  await new Promise<void>((resolve) => healthServer.close(() => resolve()))
  await connection.quit().catch(() => connection.disconnect())
  await closeClient()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
