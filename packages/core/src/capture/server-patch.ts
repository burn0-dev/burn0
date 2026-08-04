import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import { normalizeEndpoint } from '../entities/index.js'
import { openTrace, closeTrace, runInTrace } from '../context/trace.js'

/** Auto-rooted traces: one per inbound HTTP request.
 *
 *  `diagnostics_channel` notifies but never hands over the handler, so a
 *  subscriber could only use `AsyncLocalStorage.enterWith()`, which is unsafe on
 *  a reused HTTP parser. Wrapping `emit` and calling `als.run()` is the mechanism
 *  OpenTelemetry uses and the only one that is correct here. Spec §2.9. */

export interface ServerProto {
  label: string
  proto: any
}

/** `node:http2` exports neither `Http2Server` nor `Http2SecureServer` (measured
 *  on Node 22.12), so the only way to reach those prototypes is through a
 *  throwaway instance. The servers are never listened on and are closed at once. */
export function serverPrototypes(): ServerProto[] {
  const out: ServerProto[] = [
    { label: 'http.Server', proto: http.Server.prototype },
    { label: 'https.Server', proto: https.Server.prototype },
  ]
  for (const [label, make] of [
    ['Http2Server', () => http2.createServer()],
    ['Http2SecureServer', () => http2.createSecureServer()],
  ] as const) {
    try {
      const probe: any = make()
      out.push({ label, proto: Object.getPrototypeOf(probe) })
      try { probe.close() } catch {}
    } catch {}
  }
  return out
}

const PATCHED = Symbol.for('burn0.serverPatched')

export function patchServers(opts: { normalizePath?: (path: string) => string } = {}): () => void {
  const normalize = opts.normalizePath ?? normalizeEndpoint
  const restores: Array<() => void> = []

  for (const { proto } of serverPrototypes()) {
    try {
      const original = proto.emit
      const patched = function (this: any, event: string, ...args: any[]) {
        if (event !== 'request') return original.apply(this, [event, ...args])
        // Everything burn0 does here is best-effort: on any internal failure the
        // app's request proceeds through the original emit, untouched.
        try {
          const [req, res] = args
          const trace = openTrace(traceName(req, normalize), 'http-server')
          if (res && typeof res.on === 'function') {
            // 'finish' is the happy path. 'close' is the one that matters:
            // a streaming response may never finish, and without it the trace
            // sits in the pending map forever.
            const done = () => { try { closeTrace(trace.localId, res.statusCode ?? null) } catch {} }
            res.on('finish', done)
            res.on('close', done)
          }
          return runInTrace(trace, () => original.apply(this, [event, ...args]))
        } catch {
          return original.apply(this, [event, ...args])
        }
      }
      // Tolerate another APM having wrapped the same method, and tolerate being
      // patched twice ourselves — restoring in reverse order unwinds cleanly.
      ;(patched as any)[PATCHED] = true
      proto.emit = patched
      restores.push(() => { proto.emit = original })
    } catch {}
  }

  return () => {
    for (const restore of restores.reverse()) {
      try { restore() } catch {}
    }
  }
}

function traceName(req: any, normalize: (p: string) => string): string | null {
  try {
    const method = String(req?.method ?? 'GET').toUpperCase()
    const raw = String(req?.url ?? '/')
    const path = raw.split('?')[0]
    return `${method} ${normalize(path)}`
  } catch {
    return null
  }
}
