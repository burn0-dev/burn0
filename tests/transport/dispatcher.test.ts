import { describe, it, expect, vi } from 'vitest'
import { createDispatcher } from '../../src/transport/dispatcher'
import type { Burn0Event } from '../../src/types'

function makeEvent(): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    status_code: 200,
    timestamp: new Date().toISOString(),
    duration_ms: 100,
    estimated: false,
  }
}

describe('createDispatcher', () => {
  it('calls all deps for any active mode', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    for (const mode of ['dev-local', 'dev-cloud', 'prod-cloud', 'prod-local', 'test-enabled'] as const) {
      logEvent.mockClear()
      writeLedger.mockClear()
      addToBatch.mockClear()

      const dispatch = createDispatcher(mode, { logEvent, writeLedger, addToBatch })
      dispatch(makeEvent())

      expect(logEvent).toHaveBeenCalledOnce()
      expect(writeLedger).toHaveBeenCalledOnce()
      expect(addToBatch).toHaveBeenCalledOnce()
    }
  })

  it('test-disabled: is a no-op (calls nothing)', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('test-disabled', { logEvent, writeLedger, addToBatch })
    dispatch(makeEvent())

    expect(logEvent).not.toHaveBeenCalled()
    expect(writeLedger).not.toHaveBeenCalled()
    expect(addToBatch).not.toHaveBeenCalled()
  })

  it('passes the event to all called deps', () => {
    const event = makeEvent()
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('dev-cloud', { logEvent, writeLedger, addToBatch })
    dispatch(event)

    expect(logEvent).toHaveBeenCalledWith(event)
    expect(writeLedger).toHaveBeenCalledWith(event)
    expect(addToBatch).toHaveBeenCalledWith(event)
  })

  it('works without optional deps (no crash)', () => {
    const dispatch = createDispatcher('dev-local', {})
    expect(() => dispatch(makeEvent())).not.toThrow()
  })
})
