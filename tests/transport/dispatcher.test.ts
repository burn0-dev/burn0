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
  it('dev-local: calls logEvent and writeLedger', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()
    const accumulate = vi.fn()

    const dispatch = createDispatcher('dev-local', { logEvent, writeLedger, addToBatch, accumulate })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(writeLedger).toHaveBeenCalledOnce()
    expect(addToBatch).not.toHaveBeenCalled()
    expect(accumulate).not.toHaveBeenCalled()
  })

  it('dev-cloud: calls logEvent and addToBatch', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()
    const accumulate = vi.fn()

    const dispatch = createDispatcher('dev-cloud', { logEvent, writeLedger, addToBatch, accumulate })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(addToBatch).toHaveBeenCalledOnce()
    expect(writeLedger).not.toHaveBeenCalled()
    expect(accumulate).not.toHaveBeenCalled()
  })

  it('prod-cloud: only calls addToBatch (silent)', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()
    const accumulate = vi.fn()

    const dispatch = createDispatcher('prod-cloud', { logEvent, writeLedger, addToBatch, accumulate })
    dispatch(makeEvent())

    expect(addToBatch).toHaveBeenCalledOnce()
    expect(logEvent).not.toHaveBeenCalled()
    expect(writeLedger).not.toHaveBeenCalled()
    expect(accumulate).not.toHaveBeenCalled()
  })

  it('prod-local: calls accumulate only', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()
    const accumulate = vi.fn()

    const dispatch = createDispatcher('prod-local', { logEvent, writeLedger, addToBatch, accumulate })
    dispatch(makeEvent())

    expect(accumulate).toHaveBeenCalledOnce()
    expect(logEvent).not.toHaveBeenCalled()
    expect(writeLedger).not.toHaveBeenCalled()
    expect(addToBatch).not.toHaveBeenCalled()
  })

  it('test-enabled: calls logEvent, writeLedger, and addToBatch', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()
    const accumulate = vi.fn()

    const dispatch = createDispatcher('test-enabled', { logEvent, writeLedger, addToBatch, accumulate })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(writeLedger).toHaveBeenCalledOnce()
    expect(addToBatch).toHaveBeenCalledOnce()
    expect(accumulate).not.toHaveBeenCalled()
  })

  it('test-disabled: is a no-op (calls nothing)', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()
    const accumulate = vi.fn()

    const dispatch = createDispatcher('test-disabled', { logEvent, writeLedger, addToBatch, accumulate })
    dispatch(makeEvent())

    expect(logEvent).not.toHaveBeenCalled()
    expect(writeLedger).not.toHaveBeenCalled()
    expect(addToBatch).not.toHaveBeenCalled()
    expect(accumulate).not.toHaveBeenCalled()
  })

  it('passes the event to all called deps', () => {
    const event = makeEvent()
    const logEvent = vi.fn()
    const writeLedger = vi.fn()

    const dispatch = createDispatcher('dev-local', { logEvent, writeLedger })
    dispatch(event)

    expect(logEvent).toHaveBeenCalledWith(event)
    expect(writeLedger).toHaveBeenCalledWith(event)
  })

  it('works without optional deps (no crash)', () => {
    const dispatch = createDispatcher('dev-local', {})
    expect(() => dispatch(makeEvent())).not.toThrow()
  })
})
