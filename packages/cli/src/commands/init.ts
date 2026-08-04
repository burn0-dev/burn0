import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_CONFIG = {
  retentionDays: { payloads: 7, metadata: 30 },
  bodyCapBytes: 1048576,
  ignoreHosts: [],
  capturePayloads: true,
  redact: { extraHeaders: [], disable: false },
  pricingTtlHours: 24,
}

export function runInit(deps?: { cwd?: string }): void {
  const cwd = deps?.cwd ?? process.cwd()
  const p = join(cwd, 'burn0.config.json')
  if (existsSync(p)) {
    process.stdout.write(`burn0.config.json already exists — not overwriting\n`)
    return
  }
  writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
  process.stdout.write(`wrote ${p}\n`)
}
