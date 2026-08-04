import { basename, dirname } from 'node:path'
import { loadConfig } from './config/index.js'
import { resolveProject, resolveService } from './project/index.js'
import { openDatabase, ensureProject, insertRun, endRun, createWriter, type StorageDriver } from './storage/db.js'
import { WriteQueue } from './storage/queue.js'
import { pruneRetention, maybeVacuum } from './storage/retention.js'
import { drainTraces, sweepStaleTraces } from './context/trace.js'
import { loadPricing, type PricingTable } from './pricing/index.js'
import { enrich } from './capture/enrich.js'
import { patchFetch, type EmitFn } from './capture/fetch-patch.js'
import { patchHttp } from './capture/http-patch.js'
import { patchServers } from './capture/server-patch.js'
import { patchBunServe } from './capture/bun-serve-patch.js'
import { subscribeUndici } from './capture/undici-dc.js'
import { detectRuntime, runtimeCapabilities, runtimeVersion } from './runtime.js'
import type { CaptureEvent } from './types.js'

/** A trace open this long is not going to close on its own. Generous, because
 *  a long-lived SSE connection is legitimate and force-closing it early would
 *  split one real trace into two wrong ones. */
const STALE_TRACE_MS = 10 * 60_000
const STALE_SWEEP_MS = 60_000

export interface Burn0Handle {
  queue: WriteQueue
  db: StorageDriver
  counters: { errors: number; dropped: () => number }
  shutdown(): void
}

let active: Burn0Handle | null = null

export function initBurn0(overrides: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Burn0Handle | null {
  if (active) return active
  try {
    // Runtime gate: Node and Bun have real capture paths; anything else is
    // disabled loudly rather than half-working. The capability table — not the
    // runtime name — decides which patches install below.
    const runtime = detectRuntime()
    const caps = runtimeCapabilities(runtime)
    if (runtime !== 'node' && runtime !== 'bun') {
      try { process.stderr.write('[burn0] unsupported runtime, capture disabled\n') } catch {}
      return null
    }

    const cwd = overrides.cwd ?? process.cwd()
    const cfg = loadConfig(cwd, overrides.env ?? process.env)
    if (cfg.disabled) return null

    const project = resolveProject(cwd, cfg.project ?? undefined)
    const service = resolveService(cwd, project.rootPath, cfg.service ?? undefined)
    const db = openDatabase(cfg.dbPath)
    const projectId = ensureProject(db, project)
    const runId = insertRun(db, {
      projectId, service,
      pid: process.pid,
      entry: process.argv[1] ? basename(process.argv[1]) : null,
      nodeVersion: runtimeVersion(runtime),
    })
    // The writer prunes its own project, on its own config. Doing this from a
    // read command made `burn0 export` destructive and let one project's
    // retention settings expire another's rows.
    try { pruneRetention(db, cfg.retentionDays, Date.now(), projectId); maybeVacuum(db) } catch {}

    const counters = { errors: 0, dropped: () => queue.dropped }

    // Pricing: start empty, refresh async (fetch → cache → bundled snapshot)
    let pricing: PricingTable = {}
    loadPricing({ cacheDir: dirname(cfg.dbPath), ttlHours: cfg.pricingTtlHours })
      .then((t) => { pricing = t })
      .catch(() => { counters.errors++ })

    const writer = createWriter(db, { projectId, runId, service, capturePayloads: cfg.capturePayloads })
    const queue = new WriteQueue({
      // Traces are drained on the same tick as the rows they belong to, and the
      // writer inserts them first — a request can otherwise reference a trace
      // that has no row yet.
      flush: (rows) => writer.write(drainTraces(), rows),
    })

    // Streaming responses may never fire 'finish'. The patch listens for 'close'
    // too, but a connection held open indefinitely fires neither — this is the
    // backstop that keeps the pending map from growing without bound.
    const sweep = setInterval(() => {
      try {
        if (sweepStaleTraces(STALE_TRACE_MS) > 0) queue.flushNow()
      } catch { counters.errors++ }
    }, STALE_SWEEP_MS)
    sweep.unref?.()

    const emit: EmitFn = (event: CaptureEvent, isSSE: boolean) => {
      try {
        queue.push(enrich(event, {
          pricing, bodyCapBytes: cfg.bodyCapBytes,
          redactDisabled: cfg.redact.disable, extraRedactHeaders: cfg.redact.extraHeaders,
          isSSE,
        }))
      } catch { counters.errors++ }
    }

    const captureOpts = { ignoreHosts: cfg.ignoreHosts, bodyCapBytes: cfg.bodyCapBytes }
    const noop = () => {}
    const unpatchFetch = caps.patchFetch ? patchFetch(emit, captureOpts) : noop
    const unpatchHttp = caps.patchNodeHttp ? patchHttp(emit, captureOpts) : noop
    const unsubDc = caps.subscribeUndici ? subscribeUndici(emit, captureOpts) : noop
    // Inbound requests: opt-out, not opt-in (D5). Passive apart from one
    // `als.run` and an integer increment — no synchronous write on the request
    // path. Node roots at Server.prototype.emit; Bun roots at Bun.serve.
    const unpatchServers = !cfg.traceHttp ? noop
      : caps.patchNodeServers ? patchServers()
      : caps.patchBunServe ? patchBunServe()
      : noop

    const flushOnExit = () => { try { queue.flushNow() } catch {} }
    process.on('beforeExit', flushOnExit)
    process.on('exit', flushOnExit)

    active = {
      queue, db, counters,
      shutdown() {
        try { unpatchFetch() } catch {}
        try { unpatchHttp() } catch {}
        try { unpatchServers() } catch {}
        try { unsubDc() } catch {}
        try { clearInterval(sweep) } catch {}
        try { queue.stop() } catch {}
        try { endRun(db, runId) } catch {}
        try { db.close() } catch {}
        process.removeListener('beforeExit', flushOnExit)
        process.removeListener('exit', flushOnExit)
        active = null
      },
    }
    return active
  } catch {
    // Global Constraint: init failure must never crash the host app
    return null
  }
}
