import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LocalLedger } from '../../src/transport/local'
import type { Burn0Event } from '../../src/types'

function makeEvent(overrides: Partial<Burn0Event> = {}): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    status_code: 200,
    timestamp: new Date().toISOString(),
    duration_ms: 100,
    estimated: false,
    ...overrides,
  }
}

describe('LocalLedger', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes events as JSONL', () => {
    const ledger = new LocalLedger(tmpDir)
    const event = makeEvent()
    ledger.write(event)

    const filePath = path.join(tmpDir, '.burn0', 'costs.jsonl')
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ service: 'openai', endpoint: '/v1/chat/completions' })
  })

  it('creates .burn0 directory if it does not exist', () => {
    const ledger = new LocalLedger(tmpDir)
    ledger.write(makeEvent())

    expect(fs.existsSync(path.join(tmpDir, '.burn0'))).toBe(true)
  })

  it('reads back written events', () => {
    const ledger = new LocalLedger(tmpDir)
    const e1 = makeEvent({ endpoint: '/v1/chat/completions' })
    const e2 = makeEvent({ endpoint: '/v1/embeddings', service: 'anthropic' })

    ledger.write(e1)
    ledger.write(e2)

    const events = ledger.read()
    expect(events).toHaveLength(2)
    expect(events[0].endpoint).toBe('/v1/chat/completions')
    expect(events[1].endpoint).toBe('/v1/embeddings')
    expect(events[1].service).toBe('anthropic')
  })

  it('returns empty array when no file exists', () => {
    const ledger = new LocalLedger(tmpDir)
    const events = ledger.read()
    expect(events).toEqual([])
  })

  it('appends multiple events across multiple writes', () => {
    const ledger = new LocalLedger(tmpDir)

    for (let i = 0; i < 5; i++) {
      ledger.write(makeEvent({ endpoint: `/v1/endpoint-${i}` }))
    }

    const events = ledger.read()
    expect(events).toHaveLength(5)
    expect(events[4].endpoint).toBe('/v1/endpoint-4')
  })

  it('writes valid JSON for each line', () => {
    const ledger = new LocalLedger(tmpDir)
    ledger.write(makeEvent({ model: 'gpt-4o', tokens_in: 100, tokens_out: 50 }))

    const filePath = path.join(tmpDir, '.burn0', 'costs.jsonl')
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
