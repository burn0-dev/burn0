/** Runtime detection, in one place.
 *
 *  Everything that must differ between runtimes (which patches to install,
 *  which SQLite binding to open, what version string to stamp on a run) asks
 *  here rather than sniffing `process.versions` itself — scattering the checks
 *  is how a runtime ends up half-supported.
 *
 *  Order matters: Bun and Deno both present a Node-compatible `process.versions.node`,
 *  so their own markers are checked first. */

export type Runtime = 'node' | 'bun' | 'deno' | 'unknown'

export function detectRuntime(): Runtime {
  try {
    if (typeof process === 'undefined') return 'unknown'
    if ((process.versions as any)?.bun) return 'bun'
    if ((globalThis as any).Deno) return 'deno'
    if (process.versions?.node) return 'node'
  } catch {}
  return 'unknown'
}

/** What capture can do here. Derived from the runtime, consumed by init —
 *  init reads capabilities, never the runtime name, so adding a runtime later
 *  is a change to this table and not to init's wiring. */
export interface RuntimeCapabilities {
  /** Outbound capture via globalThis.fetch replacement. */
  patchFetch: boolean
  /** Outbound capture via node:http/https ClientRequest patching. Node's own
   *  implementation only — Bun's node:http compat is a different codebase and
   *  patching its internals is unverified. */
  patchNodeHttp: boolean
  /** Passive undici diagnostics_channel subscription. The channels are an
   *  undici implementation detail; Bun's fetch is native and never publishes
   *  them, so subscribing there is dead weight. */
  subscribeUndici: boolean
  /** Inbound trace roots via node:http/https/http2 Server.prototype.emit. */
  patchNodeServers: boolean
  /** Inbound trace roots via the Bun.serve property wrap. */
  patchBunServe: boolean
}

export function runtimeCapabilities(rt: Runtime = detectRuntime()): RuntimeCapabilities {
  switch (rt) {
    case 'node':
      return { patchFetch: true, patchNodeHttp: true, subscribeUndici: true, patchNodeServers: true, patchBunServe: false }
    case 'bun':
      return { patchFetch: true, patchNodeHttp: false, subscribeUndici: false, patchNodeServers: false, patchBunServe: true }
    default:
      return { patchFetch: false, patchNodeHttp: false, subscribeUndici: false, patchNodeServers: false, patchBunServe: false }
  }
}

/** Stamped into `runs.node_version`. Distinguishable at a glance: a Bun run
 *  reads `bun-1.3.9`, a Node run keeps the familiar `v22.23.2`. */
export function runtimeVersion(rt: Runtime = detectRuntime()): string | null {
  try {
    if (rt === 'bun') return `bun-${(process.versions as any).bun}`
    if (rt === 'node') return process.version
    if (rt === 'deno') return `deno-${(globalThis as any).Deno?.version?.deno ?? '?'}`
  } catch {}
  return null
}
