import { defineConfig } from 'vitest/config'

// Los tests de la API son de integración: usan el postgres y el redis del
// docker compose, con los mismos .env que la app.
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
    // todas las suites comparten el postgres del compose: en paralelo, el
    // afterAll de un archivo borra los usuarios del que sigue corriendo
    fileParallelism: false,
  },
})
