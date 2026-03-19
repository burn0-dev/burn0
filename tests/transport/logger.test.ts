import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatEventLine, formatProcessSummary, logEvent } from '../../src/transport/logger'
import type { Burn0Event } from '../../src/types'

function makeEvent(overrides: Partial<Burn0Event> = {}): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    status_code: 200,
    timestamp: '2024-01-15T14:30:00.000Z',
    duration_ms: 342,
    estimated: false,
    ...overrides,
  }
}

describe('formatEventLine', () => {
  it('formats a basic event with service and endpoint', () => {
    const event = makeEvent()
    const line = formatEventLine(event)
    expect(line).toContain('openai')
    expect(line).toContain('/v1/chat/completions')
  })

  it('uses model instead of endpoint when model is present', () => {
    const event = makeEvent({ model: 'gpt-4o' })
    const line = formatEventLine(event)
    expect(line).toContain('gpt-4o')
    expect(line).not.toContain('/v1/chat/completions')
  })

  it('includes token counts when tokens_in and tokens_out are present', () => {
    const event = makeEvent({ model: 'gpt-4o', tokens_in: 500, tokens_out: 250 })
    const line = formatEventLine(event)
    expect(line).toContain('500')
    expect(line).toContain('250')
  })

  it('formats large token counts with K suffix', () => {
    const event = makeEvent({ model: 'gpt-4o', tokens_in: 1500, tokens_out: 2000 })
    const line = formatEventLine(event)
    expect(line).toContain('1.5K')
    expect(line).toContain('2.0K')
  })

  it('does not include token info when only tokens_in is present', () => {
    const event = makeEvent({ tokens_in: 100 })
    const line = formatEventLine(event)
    expect(line).not.toContain('in ·')
  })

  it('includes service name in output', () => {
    const event = makeEvent({ timestamp: '2024-01-15T14:30:00.000Z' })
    const line = formatEventLine(event)
    expect(line).toContain('openai')
  })
})

describe('formatProcessSummary', () => {
  it('produces valid JSON', () => {
    const events = [makeEvent(), makeEvent({ service: 'anthropic' })]
    const summary = formatProcessSummary(events, 3600)
    expect(() => JSON.parse(summary)).not.toThrow()
  })

  it('includes burn0 key set to process-summary', () => {
    const summary = formatProcessSummary([], 0)
    const parsed = JSON.parse(summary)
    expect(parsed.burn0).toBe('process-summary')
  })

  it('calculates uptime_hours correctly', () => {
    const summary = formatProcessSummary([], 7200)
    const parsed = JSON.parse(summary)
    expect(parsed.uptime_hours).toBe(2)
  })

  it('counts total_calls correctly', () => {
    const events = [makeEvent(), makeEvent(), makeEvent()]
    const summary = formatProcessSummary(events, 0)
    const parsed = JSON.parse(summary)
    expect(parsed.total_calls).toBe(3)
  })

  it('groups calls by service', () => {
    const events = [
      makeEvent({ service: 'openai' }),
      makeEvent({ service: 'openai' }),
      makeEvent({ service: 'anthropic' }),
    ]
    const summary = formatProcessSummary(events, 0)
    const parsed = JSON.parse(summary)
    expect(parsed.services.openai.calls).toBe(2)
    expect(parsed.services.anthropic.calls).toBe(1)
  })

  it('sums tokens per service', () => {
    const events = [
      makeEvent({ service: 'openai', tokens_in: 100, tokens_out: 50 }),
      makeEvent({ service: 'openai', tokens_in: 200, tokens_out: 75 }),
    ]
    const summary = formatProcessSummary(events, 0)
    const parsed = JSON.parse(summary)
    expect(parsed.services.openai.tokens_in).toBe(300)
    expect(parsed.services.openai.tokens_out).toBe(125)
  })

  it('omits tokens_in/tokens_out from service when no token data', () => {
    const events = [makeEvent()]
    const summary = formatProcessSummary(events, 0)
    const parsed = JSON.parse(summary)
    expect(parsed.services.openai.tokens_in).toBeUndefined()
    expect(parsed.services.openai.tokens_out).toBeUndefined()
  })

  it('includes message field', () => {
    const summary = formatProcessSummary([], 0)
    const parsed = JSON.parse(summary)
    expect(typeof parsed.message).toBe('string')
    expect(parsed.message.length).toBeGreaterThan(0)
  })

  it('handles empty events array', () => {
    const summary = formatProcessSummary([], 1800)
    const parsed = JSON.parse(summary)
    expect(parsed.total_calls).toBe(0)
    expect(parsed.services).toEqual({})
    expect(parsed.uptime_hours).toBe(0.5)
  })
})

describe('logEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes to process.stdout', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const event = makeEvent({ model: 'gpt-4o' })
    logEvent(event)
    // First call prints header (3 lines) + event line = 4 calls
    expect(writeSpy).toHaveBeenCalled()
    const allOutput = writeSpy.mock.calls.map(c => c[0] as string).join('')
    expect(allOutput).toContain('gpt-4o')
    expect(allOutput).toContain('openai')
    expect(allOutput).toContain('burn0')
  })
})
