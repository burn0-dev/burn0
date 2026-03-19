import { describe, it, expect } from 'vitest'
import { createTracker } from '../src/track'
import type { Burn0Event } from '../src/types'

const baseEvent: Burn0Event = {
  schema_version: 1,
  service: 'openai',
  endpoint: '/v1/chat/completions',
  status_code: 200,
  timestamp: new Date().toISOString(),
  duration_ms: 123,
  estimated: false,
}

describe('createTracker', () => {
  it('track() attaches feature and metadata to events during callback', async () => {
    const { track, enrichEvent } = createTracker()

    let enriched: Burn0Event | null = null

    await track('my-feature', { user: 'alice', count: 5 }, async () => {
      enriched = enrichEvent(baseEvent)
    })

    expect(enriched).not.toBeNull()
    expect(enriched!.feature).toBe('my-feature')
    expect(enriched!.metadata).toEqual({ user: 'alice', count: 5 })
  })

  it('track() context does not bleed outside callback', async () => {
    const { track, enrichEvent } = createTracker()

    await track('scoped-feature', { x: 1 }, async () => {
      // inside callback
    })

    const outside = enrichEvent(baseEvent)
    expect(outside.feature).toBeUndefined()
    expect(outside.metadata).toBeUndefined()
  })

  it('startSpan() attaches context until span.end()', () => {
    const { startSpan, enrichEvent } = createTracker()

    const span = startSpan('span-feature', { env: 'test' })

    const duringSpan = enrichEvent(baseEvent)
    expect(duringSpan.feature).toBe('span-feature')
    expect(duringSpan.metadata).toEqual({ env: 'test' })

    span.end()

    const afterSpan = enrichEvent(baseEvent)
    expect(afterSpan.feature).toBeUndefined()
    expect(afterSpan.metadata).toBeUndefined()
  })
})
