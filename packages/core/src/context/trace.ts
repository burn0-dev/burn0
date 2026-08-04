import { AsyncLocalStorage } from 'node:async_hooks'

/** Trace context.
 *
 *  A trace is one logical unit of work — an inbound HTTP request, or an explicit
 *  `withTrace`. It lives in memory long before it is a row, so everything here
 *  deals in `localId`; the write path resolves those to database ids at flush.
 *
 *  The mechanism is `als.run()` around the server's `request` emit, never
 *  `AsyncLocalStorage.enterWith()`. See spec §2.9: `enterWith` is unsafe on a
 *  reused HTTP parser (nodejs/node#41978, open since 2022), and
 *  `diagnostics_channel.bindStore()` does not fire for `http.server.request.start`
 *  because Node publishes it without `runStores`. */

export type TraceKind = 'http-server' | 'explicit' | 'tool'

export type ToolStatus = 'ok' | 'error' | 'unresolved'
export type Attribution = 'exact' | 'window' | 'turn' | 'none'

export interface PendingTrace {
  localId: number
  parentLocalId: number | null
  name: string | null
  kind: TraceKind
  startedAt: number
  endedAt: number | null
  status: number | null
  /** Force-closed by the sweep because the response never finished. */
  incomplete: boolean
  /** kind === 'tool' only. */
  toolStatus?: ToolStatus | null
  attribution?: Attribution | null
  args?: string | null
  result?: string | null
}

export interface TraceStep {
  localId: number
  seq: number
}

interface TraceCtx {
  localId: number
  /** Shared with the whole subtree, so `seq` orders a trace's calls across
   *  nesting levels and the tree view can sort on it alone. */
  seq: { n: number }
  depth: number
}

/** A recursive structure built from user-controlled call sites needs a hard stop.
 *  Past this, `withTrace` is a no-op and calls flatten onto the last valid parent. */
export const MAX_TRACE_DEPTH = 32

/** A server that never closes its traces (the SSE shape) must not grow the map
 *  without bound. The sweep is the real fix; this is the backstop under it. */
export const MAX_LIVE_TRACES = 10_000

const als = new AsyncLocalStorage<TraceCtx>()

let nextLocalId = 1
const live = new Map<number, PendingTrace>()
let openedQueue: PendingTrace[] = []
let closedQueue: PendingTrace[] = []

export function openTrace(
  name: string | null, kind: TraceKind,
  opts: { parentLocalId?: number | null; now?: number } = {},
): PendingTrace {
  const t: PendingTrace = {
    localId: nextLocalId++,
    parentLocalId: opts.parentLocalId ?? null,
    name, kind,
    startedAt: opts.now ?? Date.now(),
    endedAt: null, status: null, incomplete: false,
  }
  live.set(t.localId, t)
  openedQueue.push(t)
  // Drop oldest first: a stuck old trace is less interesting than a live new one.
  while (live.size > MAX_LIVE_TRACES) {
    const oldest = live.keys().next()
    if (oldest.done) break
    live.delete(oldest.value)
  }
  return t
}

export function closeTrace(localId: number, status: number | null = null, now = Date.now()): void {
  const t = live.get(localId)
  if (!t) return          // already closed: `res` emits both 'finish' and 'close'
  live.delete(localId)
  t.endedAt = now
  t.status = status
  closedQueue.push(t)
  // A tool the agent never sent results back for closes with the trace, as
  // `unresolved` — the other shape of quiet agent failure (§8.5).
  for (const [key, toolLocalId] of openTools) {
    if (!key.startsWith(`${localId}:`)) continue
    openTools.delete(key)
    const tool = live.get(toolLocalId)
    if (!tool) continue
    live.delete(toolLocalId)
    tool.endedAt = now
    tool.toolStatus = 'unresolved'
    closedQueue.push(tool)
  }
}

/** `${enclosingTraceLocalId}:${providerToolId}` → tool trace localId. */
const openTools = new Map<string, number>()

/** A tool call declared by an LLM response. Its window opens when the response
 *  that declared it completed, and closes when a later request carries its
 *  result (§8.4). Both ends are events burn0 already observes. */
export function openToolTrace(opts: {
  parentLocalId: number
  toolId: string
  name: string
  args: string | null
  attribution: Attribution
  now: number
}): PendingTrace {
  const t = openTrace(opts.name, 'tool', { parentLocalId: opts.parentLocalId, now: opts.now })
  t.toolStatus = null
  t.attribution = opts.attribution
  t.args = opts.args
  openTools.set(`${opts.parentLocalId}:${opts.toolId}`, t.localId)
  return t
}

export function closeToolTrace(opts: {
  parentLocalId: number
  toolId: string
  result: string | null
  isError: boolean
  now: number
}): boolean {
  const key = `${opts.parentLocalId}:${opts.toolId}`
  const localId = openTools.get(key)
  if (localId == null) return false
  openTools.delete(key)
  const t = live.get(localId)
  if (!t) return false
  live.delete(localId)
  t.endedAt = opts.now
  t.toolStatus = opts.isError ? 'error' : 'ok'
  t.result = opts.result
  closedQueue.push(t)
  return true
}

export function runInTrace<T>(t: PendingTrace, fn: () => T): T {
  return als.run({ localId: t.localId, seq: { n: 0 }, depth: 1 }, fn)
}

/** Read when the call *starts*, not when it completes — by response time the
 *  async context has already moved on. */
export function takeTraceStep(): TraceStep | null {
  const ctx = als.getStore()
  if (!ctx) return null
  return { localId: ctx.localId, seq: ctx.seq.n++ }
}

export function withTrace<T>(name: string, fn: () => T): T {
  const parent = als.getStore()
  if (parent && parent.depth >= MAX_TRACE_DEPTH) return fn()

  const t = openTrace(name, 'explicit', { parentLocalId: parent?.localId ?? null })
  const ctx: TraceCtx = {
    localId: t.localId,
    seq: parent ? parent.seq : { n: 0 },
    depth: (parent?.depth ?? 0) + 1,
  }
  const done = () => { try { closeTrace(t.localId) } catch {} }

  try {
    const out = als.run(ctx, fn)
    if (out && typeof (out as any).then === 'function') {
      return (out as any).then(
        (v: unknown) => { done(); return v },
        (e: unknown) => { done(); throw e },
      ) as T
    }
    done()
    return out
  } catch (err) {
    done()
    throw err
  }
}

/** Hand opened and closed traces to the writer. Each is handed over once — the
 *  writer inserts opened rows, then updates closed ones, in one transaction. */
export function drainTraces(): { opened: PendingTrace[]; closed: PendingTrace[] } {
  const out = { opened: openedQueue, closed: closedQueue }
  openedQueue = []
  closedQueue = []
  return out
}

/** SSE and other streaming responses may never fire `finish`. Without this the
 *  trace sits in `live` forever — burn0's own memory leak, and the *normal*
 *  shape for this product's users. */
export function sweepStaleTraces(maxAgeMs: number, now = Date.now()): number {
  let swept = 0
  for (const [id, t] of live) {
    if (now - t.startedAt < maxAgeMs) continue
    live.delete(id)
    t.endedAt = now
    t.incomplete = true
    closedQueue.push(t)
    swept++
  }
  return swept
}

export function liveTraceCount(): number {
  return live.size
}

export function resetTraces(): void {
  live.clear()
  openTools.clear()
  openedQueue = []
  closedQueue = []
  nextLocalId = 1
}
