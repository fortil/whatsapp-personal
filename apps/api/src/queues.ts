import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

/**
 * Lado productor de la cola BullMQ. El worker (apps/worker) consume la misma
 * cola 'tasks'. La conexión se abre recién en el primer uso: los tests inyectan
 * su propio productor y nunca tocan redis de más.
 */

export const QUEUE_NAME = 'tasks'

/** Contrato mínimo que la ruta necesita; los tests inyectan una versión grabada. */
export interface TaskProducer {
  add(name: string, data: unknown): Promise<string>
}

/** attempts 3 con backoff exponencial, como fija el plan para los jobs. */
export const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 3_600 },
  removeOnFail: { age: 24 * 3_600 },
}

let connection: Redis | undefined
let queue: Queue | undefined

export function getTaskQueue(): Queue {
  if (!queue) {
    if (!connection) {
      const url = process.env.REDIS_URL
      if (!url) throw new Error('REDIS_URL no está definida. Copia .env.example a .env y llénala.')
      // BullMQ exige maxRetriesPerRequest: null en la conexión que usa
      connection = new Redis(url, { maxRetriesPerRequest: null })
    }
    queue = new Queue(QUEUE_NAME, { connection })
  }
  return queue
}

export function bullmqProducer(): TaskProducer {
  return {
    async add(name, data) {
      const job = await getTaskQueue().add(name, data, JOB_DEFAULTS)
      return job.id ?? ''
    },
  }
}

export async function closeTaskQueue(): Promise<void> {
  await queue?.close().catch(() => {})
  queue = undefined
  if (connection) {
    await connection.quit().catch(() => connection?.disconnect())
    connection = undefined
  }
}

/** Encola el job de transcripción de un mensaje de audio. */
export async function enqueueTranscribe(
  messageId: string,
  producer: TaskProducer = bullmqProducer(),
): Promise<string> {
  return producer.add('transcribe', { messageId })
}
