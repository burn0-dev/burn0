import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInit } from '../src/commands/init.js'
import { runWatch } from '../src/commands/watch.js'
import { seedDb, baseRow } from './helpers/seed.js'
import { ensureProject, insertRows } from '@burn0/core'

describe('runInit', () => {
  it('writes default config, refuses overwrite', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'burn0-init-'))
    runInit({ cwd })
    const p = join(cwd, 'burn0.config.json')
    expect(existsSync(p)).toBe(true)
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    expect(cfg.retentionDays).toEqual({ payloads: 7, metadata: 30 })
    // second run must not clobber
    expect(() => runInit({ cwd })).not.toThrow()
  })
})

describe('runWatch', () => {
  it('prints new rows as they appear', async () => {
    vi.useFakeTimers()
    const { db } = seedDb([])
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { lines.push(String(s)); return true })
    runWatch({ db, intervalMs: 100, maxTicks: 3 })
    const pid = ensureProject(db, { key: 'path:/x', name: 'test-app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [baseRow({ url: 'https://api.openai.com/v1/x', normalizedEndpoint: '/v1/x' })], true)
    await vi.advanceTimersByTimeAsync(350)
    spy.mockRestore()
    vi.useRealTimers()
    expect(lines.join('')).toContain('/v1/x')
    expect(lines.join('')).toContain('OpenAI')
  })
})
