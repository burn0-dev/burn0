import { defineConfig } from 'tsdown'
import { copyFileSync, mkdirSync } from 'node:fs'

export default defineConfig({
  entry: ['src/index.ts', 'src/register.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  hooks: {
    'build:done': async () => {
      mkdirSync('dist/pricing', { recursive: true })
      copyFileSync('src/pricing/snapshot.json', 'dist/pricing/snapshot.json')
    },
  },
})
