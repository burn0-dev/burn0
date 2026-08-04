import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // tests/bun/** is a bun:test suite (`pnpm test:bun`): it imports bun:sqlite
    // and Bun globals, neither of which exists under vitest's Node runner.
    exclude: ['**/node_modules/**', 'tests/bun/**'],
  },
})
