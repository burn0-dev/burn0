import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBurn0 } from '../src/init.js'

describe('initBurn0', () => {
  it('returns null when disabled via env', () => {
    expect(initBurn0({ env: { BURN0_DISABLED: '1' } })).toBeNull()
  })
  it('returns null in production without force', () => {
    expect(initBurn0({ env: { NODE_ENV: 'production' } })).toBeNull()
  })
  it('initializes db, prunes, and captures a real fetch end-to-end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-init-'))
    const dbPath = join(dir, 'burn0.db')
    const handle = initBurn0({ env: { BURN0_DB_PATH: dbPath } })
    expect(handle).not.toBeNull()
    expect(existsSync(dbPath)).toBe(true)

    const { createServer } = await import('node:http')
    const server = createServer((_q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"ok":true}') })
    await new Promise<void>((r) => server.listen(0, () => r()))
    const port = (server.address() as any).port
    await (await fetch(`http://127.0.0.1:${port}/ping`)).text()
    await new Promise((r) => setTimeout(r, 100))
    handle!.queue.flushNow()

    const row = handle!.db.prepare(`SELECT * FROM requests WHERE url LIKE '%/ping'`).get()
    expect(row).toBeDefined()
    expect(row.status).toBe(200)
    handle!.shutdown()
    server.close()
  })
  it('double init returns the same handle (idempotent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-init2-'))
    const env = { BURN0_DB_PATH: join(dir, 'burn0.db') }
    const a = initBurn0({ env })
    const b = initBurn0({ env })
    expect(b).toBe(a)
    a!.shutdown()
  })
})
