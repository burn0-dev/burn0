import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LocalLedger } from '../../src/transport/local'
import type { Burn0Event } from '../../src/types'

vi.mock('../../src/transport/local-pricing', () => ({
  estimateLocalCost: vi.fn((event: any) => {
    if (event.service === 'github-api') return { type: 'free' as const }
    if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
      return { type: 'priced' as const, cost: 0.01 }
    }
    return { type: 'unknown' as const }
  }),
  fetchPricing: vi.fn(async () => {}),
}))

function makeEvent(overrides: Partial<Burn0Event> = {}): Burn0Event {
  return {
    schema_version: 1, service: 'openai', endpoint: '/v1/chat/completions',
    model: 'gpt-4o-mini', tokens_in: 500, tokens_out: 100,
    status_code: 200, timestamp: new Date().toISOString(),
    duration_ms: 200, estimated: false, ...overrides,
  }
}

describe('report aggregation', () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-report-')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('aggregates costs by service from ledger events', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const ledger = new LocalLedger(tmpDir)
    ledger.write(makeEvent({ service: 'openai' }))
    ledger.write(makeEvent({ service: 'openai' }))
    ledger.write(makeEvent({ service: 'anthropic' }))
    const result = aggregateLocal(ledger.read(), 7)
    expect(result.total.calls).toBe(3)
    expect(result.total.cost).toBeGreaterThan(0)
    expect(result.byService.length).toBe(2)
    expect(result.byService[0].name).toBe('openai')
    expect(result.byService[0].calls).toBe(2)
  })

  it('excludes free services from cost summary', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const ledger = new LocalLedger(tmpDir)
    ledger.write(makeEvent({ service: 'openai' }))
    ledger.write(makeEvent({ service: 'github-api' }))
    const result = aggregateLocal(ledger.read(), 7)
    expect(result.total.calls).toBe(2)
    expect(result.byService.length).toBe(1)
    expect(result.byService[0].name).toBe('openai')
  })

  it('filters events by date range', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const today = new Date()
    const oldDate = new Date(today)
    oldDate.setDate(oldDate.getDate() - 10)
    const events = [
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: oldDate.toISOString() }),
    ]
    const result = aggregateLocal(events, 7)
    expect(result.total.calls).toBe(1)
  })

  it('groups events by day for daily breakdown', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const events = [
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: yesterday.toISOString() }),
    ]
    const result = aggregateLocal(events, 7)
    expect(result.byDay.length).toBe(2)
  })

  it('returns empty result for no events', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const result = aggregateLocal([], 7)
    expect(result.total.calls).toBe(0)
    expect(result.total.cost).toBe(0)
    expect(result.byService.length).toBe(0)
    expect(result.byDay.length).toBe(0)
  })

  it('tracks all service call counts including free services', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const events = [
      makeEvent({ service: 'openai' }),
      makeEvent({ service: 'github-api' }),
      makeEvent({ service: 'github-api' }),
    ]
    const result = aggregateLocal(events, 7)
    expect(result.allServiceCalls.length).toBe(2)
    expect(result.allServiceCalls.find(s => s.name === 'github-api')?.calls).toBe(2)
  })

  it('filters to today only when days=1', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const events = [
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: yesterday.toISOString() }),
    ]
    const result = aggregateLocal(events, 1)
    expect(result.total.calls).toBe(1)
  })
})
