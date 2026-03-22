import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTicker } from '../../src/transport/logger'
import type { Burn0Event } from '../../src/types'

vi.mock('../../src/transport/local-pricing', () => ({
  estimateLocalCost: vi.fn((event: any) => {
    if (event.service === 'free-svc') return { type: 'free' as const }
    if (event.service === 'unknown-svc') return { type: 'unknown' as const }
    if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
      return { type: 'priced' as const, cost: 0.01 }
    }
    return { type: 'no-tokens' as const }
  }),
}))

function makeEvent(overrides: Partial<Burn0Event> = {}): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    model: 'gpt-4o',
    tokens_in: 500,
    tokens_out: 250,
    status_code: 200,
    timestamp: new Date().toISOString(),
    duration_ms: 342,
    estimated: false,
    ...overrides,
  }
}

describe('createTicker', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a ticker with tick and printExitSummary methods', () => {
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    expect(typeof ticker.tick).toBe('function')
    expect(typeof ticker.printExitSummary).toBe('function')
  })

  it('tick writes to stderr when isTTY is true', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    expect(stderrSpy).toHaveBeenCalled()
    const output = stderrSpy.mock.calls.map(c => c[0] as string).join('')
    expect(output).toContain('burn0')
    expect(output).toContain('$')
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('tick does NOT write to stderr when isTTY is false', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: false, writable: true })
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    expect(stderrSpy).not.toHaveBeenCalled()
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('accumulates session cost across ticks', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    ticker.tick(makeEvent())
    ticker.tick(makeEvent())
    const lastCall = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1][0] as string
    expect(lastCall).toContain('3 calls')
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('seeds today cost from init', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })
    const ticker = createTicker({ todayCost: 5.0, todayCalls: 20, perServiceCosts: { openai: 5.0 } })
    ticker.tick(makeEvent())
    const lastCall = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1][0] as string
    expect(lastCall).toContain('21 calls')
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('does not count free/unknown services in cost breakdown', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent({ service: 'free-svc' }))
    const lastCall = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1][0] as string
    expect(lastCall).not.toContain('free-svc')
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary writes session and today totals', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })
    const ticker = createTicker({ todayCost: 10.0, todayCalls: 50, perServiceCosts: {} })
    ticker.tick(makeEvent())
    stderrSpy.mockClear()
    ticker.printExitSummary()
    const output = stderrSpy.mock.calls.map(c => c[0] as string).join('')
    expect(output).toContain('session')
    expect(output).toContain('today')
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary is idempotent (only prints once)', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    stderrSpy.mockClear()
    ticker.printExitSummary()
    const firstCallCount = stderrSpy.mock.calls.length
    ticker.printExitSummary()
    expect(stderrSpy.mock.calls.length).toBe(firstCallCount)
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary does not print if no calls were made', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.printExitSummary()
    expect(stderrSpy).not.toHaveBeenCalled()
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary does not write when stderr is not TTY', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: false, writable: true })
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    ticker.printExitSummary()
    expect(stderrSpy).not.toHaveBeenCalled()
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })
})
