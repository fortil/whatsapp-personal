import { defineConfig } from 'drizzle-kit'

// `drizzle-kit generate` no conecta a la DB; el url es para push/studio,
// que aquí no se usan (las migraciones van por generate + migrate versionado).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/whatsapp_personal',
  },
})
