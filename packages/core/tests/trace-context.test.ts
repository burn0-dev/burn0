import { describe, it, expect, beforeEach } from 'vitest'
import {
  openTrace, closeTrace, runInTrace, takeTraceStep, drainTraces,
  sweepStaleTraces, withTrace, resetTraces, liveTraceCount,
  MAX_TRACE_DEPTH, MAX_LIVE_TRACES,
} from '../src/context/trace.js'

beforeEach(() => resetTraces())

describe('trace context', () => {
  it('attributes calls made inside a trace, and nothing outside one', () => {
    const t = openTrace('POST /api/chat', 'http-server')
    expect(takeTraceStep()).toBeNull()          // outside: untraced, never orphaned
    runInTrace(t, () => {
      expect(takeTraceStep()).toEqual({ localId: t.localId, seq: 0 })
      expect(takeTraceStep()).toEqual({ localId: t.localId, seq: 1 })
    })
    expect(takeTraceStep()).toBeNull()
  })

  it('keeps concurrent traces apart', async () => {
    const seen: Array<{ trace: number; seq: number }> = []
    const run = async (name: string) => {
      const t = openTrace(name, 'http-server')
      await runInTrace(t, async () => {
        seen.push({ trace: takeTraceStep()!.localId, seq: 0 })
        await new Promise((r) => setTimeout(r, 5))
        const step = takeTraceStep()!
        seen.push({ trace: step.localId, seq: step.seq })
      })
    }
    await Promise.all([run('a'), run('b'), run('c')])
    // each trace saw its own two steps, seq 0 then 1 — no interleaving
    const byTrace = new Map<number, number[]>()
    for (const s of seen) byTrace.set(s.trace, [...(byTrace.get(s.trace) ?? []), s.seq])
    expect(byTrace.size).toBe(3)
    for (const seqs of byTrace.values()) expect(seqs).toEqual([0, 1])
  })

  it('nested withTrace produces a parent link and one shared step counter', async () => {
    const root = openTrace('POST /api/chat', 'http-server')
    await runInTrace(root, async () => {
      takeTraceStep()                                  // seq 0, on the root
      await withTrace('retrieve-context', async () => {
        takeTraceStep()                                // seq 1, on the child
      })
      takeTraceStep()                                  // seq 2, back on the root
    })
    const { opened } = drainTraces()
    const child = opened.find((t) => t.name === 'retrieve-context')!
    expect(child.parentLocalId).toBe(root.localId)
    expect(child.kind).toBe('explicit')
  })

  it('seq orders the whole subtree, so a trace view can sort on it alone', async () => {
    const steps: Array<{ localId: number; seq: number }> = []
    const root = openTrace('root', 'http-server')
    await runInTrace(root, async () => {
      steps.push(takeTraceStep()!)
      await withTrace('inner', async () => { steps.push(takeTraceStep()!) })
      steps.push(takeTraceStep()!)
    })
    expect(steps.map((s) => s.seq)).toEqual([0, 1, 2])
    expect(steps[1].localId).not.toBe(root.localId)   // attributed to the child
  })

  it('refuses to nest past the depth cap and flattens onto the last valid parent', () => {
    const root = openTrace('root', 'http-server')
    let deepest: number | null = null
    runInTrace(root, () => {
      const recurse = (n: number): void => {
        if (n === 0) { deepest = takeTraceStep()!.localId; return }
        withTrace(`level-${n}`, () => recurse(n - 1))
      }
      recurse(MAX_TRACE_DEPTH + 10)
    })
    const { opened } = drainTraces()
    // runaway recursion degrades to a wrong-looking trace, never an unbounded insert
    expect(opened.length).toBeLessThanOrEqual(MAX_TRACE_DEPTH + 1)
    expect(deepest).not.toBeNull()
  })

  it('withTrace closes on success, on throw, and on rejection', async () => {
    withTrace('ok', () => 1)
    expect(() => withTrace('sync-throw', () => { throw new Error('x') })).toThrow()
    await expect(withTrace('async-throw', async () => { throw new Error('y') })).rejects.toThrow()
    await withTrace('async-ok', async () => 2)
    const { closed } = drainTraces()
    expect(closed.map((t) => t.name).sort()).toEqual(['async-ok', 'async-throw', 'ok', 'sync-throw'])
    expect(closed.every((t) => t.endedAt != null)).toBe(true)
  })

  it('drain hands over each trace exactly once', () => {
    const t = openTrace('a', 'http-server')
    expect(drainTraces().opened).toHaveLength(1)
    expect(drainTraces().opened).toHaveLength(0)   // already handed over
    closeTrace(t.localId, 200)
    expect(drainTraces().closed).toHaveLength(1)
    expect(drainTraces().closed).toHaveLength(0)
  })
})

describe('leak containment', () => {
  it('sweeps a trace whose response never finished, and marks it incomplete', () => {
    // the SSE shape: an LLM backend streams, `finish` never fires
    const t = openTrace('POST /api/stream', 'http-server', { now: 1_000 })
    drainTraces()
    expect(liveTraceCount()).toBe(1)

    sweepStaleTraces(60_000, 30_000)     // 29s old — still streaming, leave it
    expect(liveTraceCount()).toBe(1)

    sweepStaleTraces(60_000, 120_000)    // 119s old — force-close
    expect(liveTraceCount()).toBe(0)
    const { closed } = drainTraces()
    expect(closed).toHaveLength(1)
    expect(closed[0].localId).toBe(t.localId)
    expect(closed[0].incomplete).toBe(true)
  })

  it('closing twice does not double-report', () => {
    const t = openTrace('a', 'http-server')
    closeTrace(t.localId, 200)
    closeTrace(t.localId, 200)     // res emits both 'finish' and 'close'
    expect(drainTraces().closed).toHaveLength(1)
  })

  it('bounds the live map so a permanently leaking server cannot grow without limit', () => {
    for (let i = 0; i < MAX_LIVE_TRACES + 50; i++) openTrace(`t${i}`, 'http-server')
    expect(liveTraceCount()).toBeLessThanOrEqual(MAX_LIVE_TRACES)
  })
})
