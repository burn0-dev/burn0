import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LocalLedger } from '../../src/transport/local'
import type { Burn0Event } from '../../src/types'

function makeEvent(service = 'openai'): Burn0Event {
  return {
    schema_version: 1, service, endpoint: '/v1/test',
    status_code: 200, timestamp: new Date().toISOString(),
    duration_ms: 100, estimated: false,
  }
}

describe('report data', () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-report-')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('groups events by service', () => {
    const ledger = new LocalLedger(tmpDir)
    ledger.write(makeEvent('openai'))
    ledger.write(makeEvent('openai'))
    ledger.write(makeEvent('stripe'))
    const events = ledger.read()
    const byService: Record<string, number> = {}
    for (const e of events) byService[e.service] = (byService[e.service] ?? 0) + 1
    expect(byService['openai']).toBe(2)
    expect(byService['stripe']).toBe(1)
  })
})
