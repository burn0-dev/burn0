import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BatchBuffer } from '../../src/transport/batch'
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

describe('BatchBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes when size threshold is reached', () => {
    const flushed: Burn0Event[][] = []
    const buf = new BatchBuffer({
      sizeThreshold: 3,
      timeThresholdMs: 60_000,
      maxSize: 100,
      onFlush: (events) => flushed.push(events),
    })

    buf.add(makeEvent())
    buf.add(makeEvent())
    expect(flushed).toHaveLength(0)

    buf.add(makeEvent())
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toHaveLength(3)

    buf.destroy()
  })

  it('flushes when time threshold is reached', () => {
    const flushed: Burn0Event[][] = []
    const buf = new BatchBuffer({
      sizeThreshold: 100,
      timeThresholdMs: 5_000,
      maxSize: 100,
      onFlush: (events) => flushed.push(events),
    })

    buf.add(makeEvent())
    buf.add(makeEvent())
    expect(flushed).toHaveLength(0)

    vi.advanceTimersByTime(5_000)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toHaveLength(2)

    buf.destroy()
  })

  it('drops oldest events when maxSize is exceeded', () => {
    const flushed: Burn0Event[][] = []
    const buf = new BatchBuffer({
      sizeThreshold: 1000,
      timeThresholdMs: 60_000,
      maxSize: 3,
      onFlush: (events) => flushed.push(events),
    })

    const e1 = makeEvent({ endpoint: '/a' })
    const e2 = makeEvent({ endpoint: '/b' })
    const e3 = makeEvent({ endpoint: '/c' })
    const e4 = makeEvent({ endpoint: '/d' })

    buf.add(e1)
    buf.add(e2)
    buf.add(e3)
    buf.add(e4) // should drop e1

    buf.flush()

    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toHaveLength(3)
    expect(flushed[0].map(e => e.endpoint)).toEqual(['/b', '/c', '/d'])

    buf.destroy()
  })

  it('skips empty flush', () => {
    const flushed: Burn0Event[][] = []
    const buf = new BatchBuffer({
      sizeThreshold: 10,
      timeThresholdMs: 60_000,
      maxSize: 100,
      onFlush: (events) => flushed.push(events),
    })

    buf.flush()
    expect(flushed).toHaveLength(0)

    buf.destroy()
  })

  it('does not flush empty buffer on timer tick', () => {
    const flushed: Burn0Event[][] = []
    const buf = new BatchBuffer({
      sizeThreshold: 100,
      timeThresholdMs: 1_000,
      maxSize: 100,
      onFlush: (events) => flushed.push(events),
    })

    vi.advanceTimersByTime(5_000)
    expect(flushed).toHaveLength(0)

    buf.destroy()
  })

  it('stops timer on destroy', () => {
    const flushed: Burn0Event[][] = []
    const buf = new BatchBuffer({
      sizeThreshold: 100,
      timeThresholdMs: 1_000,
      maxSize: 100,
      onFlush: (events) => flushed.push(events),
    })

    buf.add(makeEvent())
    buf.destroy()

    vi.advanceTimersByTime(5_000)
    expect(flushed).toHaveLength(0)
  })

  it('clears events after flush', () => {
    const flushed: Burn0Event[][] = []
    const buf = new BatchBuffer({
      sizeThreshold: 100,
      timeThresholdMs: 60_000,
      maxSize: 100,
      onFlush: (events) => flushed.push(events),
    })

    buf.add(makeEvent())
    buf.flush()
    buf.flush() // second flush should be no-op

    expect(flushed).toHaveLength(1)

    buf.destroy()
  })
})
