import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Resolve the workspace package to its source, not its build output. Without
  // this a core change is invisible to CLI tests until someone remembers to
  // rebuild, and the suite reports green against stale dist.
  resolve: {
    alias: {
      '@burn0/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: { environment: 'node' },
})
