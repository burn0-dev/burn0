import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      register: 'src/register.ts',
      track: 'src/track.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['commander', '@inquirer/prompts', 'chalk'],
  },
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['cjs'],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    noExternal: ['commander', '@inquirer/prompts', 'chalk'],
  },
])
