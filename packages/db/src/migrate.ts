import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { closeClient, getDb } from './client.js'

// dist/migrate.js → ../drizzle = packages/db/drizzle (independiente del cwd)
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.resolve(here, '../drizzle')

const db = getDb()
try {
  await migrate(db, { migrationsFolder })
  console.log('Migraciones aplicadas')
} finally {
  await closeClient()
}
