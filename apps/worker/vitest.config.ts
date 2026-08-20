import { defineConfig } from 'vitest/config'

// Igual que apps/api: los tests de runTranscribe son de integración contra
// el postgres del compose, con el mismo .env que el worker.
try {
  process.loadEnvFile('../../.env')
} catch {
  // sin .env los tests fallan al conectar; el error de conexión es suficiente
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})
