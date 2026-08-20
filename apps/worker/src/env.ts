/**
 * Env del worker. DATABASE_URL y REDIS_URL son obligatorias; el resto
 * degrada (sin Evolution no se pueden bajar audios, sin ASR la
 * transcripción falla con mensaje claro; sin Google los jobs de cumpleaños
 * fallan con mensaje claro porque la vinculación ni existe).
 */
export interface WorkerEnv {
  databaseUrl: string
  redisUrl: string
  evolutionApiUrl: string
  evolutionApiKey: string
  workerPort: number
  /** Cada cuánto corre el barrido del reaper. */
  reaperIntervalMs: number
  /** Dónde caen los xlsx exportados; el job guarda la ruta absoluta en task_runs. */
  exportDir: string
  googleClientId: string
  googleClientSecret: string
  /** 32 bytes hex; descifra los refresh tokens guardados por la API. */
  encryptionKey: string
}

export function readWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return {
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    evolutionApiUrl: env.EVOLUTION_API_URL ?? '',
    evolutionApiKey: env.EVOLUTION_API_KEY ?? '',
    workerPort: Number(env.WORKER_PORT ?? 3002),
    reaperIntervalMs: Number(env.REAPER_INTERVAL_MS ?? 60_000),
    exportDir: env.EXPORT_DIR || './var/exports',
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    encryptionKey: env.ENCRYPTION_KEY ?? '',
  }
}

export function missingStartupEnv(env: WorkerEnv): string[] {
  const missing: string[] = []
  if (!env.databaseUrl) missing.push('DATABASE_URL')
  if (!env.redisUrl) missing.push('REDIS_URL')
  return missing
}
