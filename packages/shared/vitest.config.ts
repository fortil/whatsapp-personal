import { defineConfig } from 'vitest/config'

// Solo los fuentes: sin esto vitest también ejecuta dist/phone.test.js
// (el build de tsc copia los tests a dist).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
