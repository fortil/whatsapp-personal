import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'

export type Db = PostgresJsDatabase<typeof schema>

let client: postgres.Sql | undefined
let db: Db | undefined

/**
 * Conexión perezosa y única al postgres local. Los scripts (migrate, seed)
 * solo pagan la conexión cuando la usan; la API y el worker la reutilizan.
 */
export function getClient(): postgres.Sql {
  if (!client) {
    const url = process.env.DATABASE_URL
    if (!url) {
      throw new Error('DATABASE_URL no está definida. Copia .env.example a .env y llénala.')
    }
    // NOTICE de postgres (CREATE SCHEMA IF NOT EXISTS del migrator) al log
    client = postgres(url, { onnotice: () => {} })
  }
  return client
}

export function getDb(): Db {
  if (!db) db = drizzle(getClient(), { schema })
  return db
}

/** Cierra la conexión: obligatorio en scripts, si no node no termina. */
export async function closeClient(): Promise<void> {
  if (client) {
    await client.end()
    client = undefined
    db = undefined
  }
}

export { schema }
