import { normalizeEndpoint } from '../entities/index.js'
import { openTrace, closeTrace, runInTrace, type PendingTrace } from '../context/trace.js'

/** Auto-rooted traces on Bun: one per inbound request, by wrapping `Bun.serve`.
 *
 *  This is the Bun analogue of server-patch.ts. Node exposes no handler to
 *  wrap, so there the server's `emit` is patched; Bun hands the handler over
 *  as `options.fetch`, which is strictly easier — wrap it in `als.run` before
 *  the native server ever sees it.
 *
 *  The load-bearing fact (verified on Bun 1.3.9): a module's default export
 *  (`export default app` — the standard Hono deployment shape) is auto-served
 *  by the runtime *through the patchable JS `Bun.serve` property*, not through
 *  a private native path. One wrap therefore covers explicit `Bun.serve({...})`,
 *  default-export auto-serve, and every framework adapter built on either.
 *
 *  What this cannot cover: servers built on Bun's node:http compat layer
 *  (`http.createServer` under Bun). That is a separate implementation from
 *  Node's and from Bun.serve; patching its internals is unverified, so those
 *  servers get outbound capture but no automatic trace roots. */

const PATCHED = Symbol.for('burn0.bunServePatched')

export function patchBunServe(opts: { normalizePath?: (path: string) => string } = {}): () => void {
  const normalize = opts.normalizePath ?? normalizeEndpoint
  const B = (globalThis as any).Bun
  if (!B || typeof B.serve !== 'function' || (B.serve as any)[PATCHED]) return () => {}

  const original = B.serve
  const patched = function serve(this: any, options: any, ...rest: any[]) {
    // Everything burn0 does is best-effort: if wrapping fails for any reason,
    // the app's server starts on its untouched options.
    let wrapped = options
    try { wrapped = wrapServeOptions(options, normalize) } catch {}
    const server = original.call(this, wrapped, ...rest)
    // `server.reload(newOptions)` swaps handlers on a live server (--hot uses
    // it). Unwrapped, a reload would silently turn tracing off.
    try {
      if (server && typeof server.reload === 'function' && !(server.reload as any)[PATCHED]) {
        const origReload = server.reload
        const reload = function (this: any, next: any, ...a: any[]) {
          let w = next
          try { w = wrapServeOptions(next, normalize) } catch {}
          return origReload.call(this, w, ...a)
        }
        ;(reload as any)[PATCHED] = true
        server.reload = reload
      }
    } catch {}
    return server
  }
  ;(patched as any)[PATCHED] = true
  B.serve = patched

  return () => { B.serve = original }
}

function wrapServeOptions(options: any, normalize: (p: string) => string): any {
  if (!options || typeof options !== 'object') return options
  const out = { ...options }
  if (typeof options.fetch === 'function') out.fetch = wrapHandler(options.fetch, normalize)
  // Bun 1.2+ `routes`: value may be a Response, a handler, or a per-method map.
  // Static Responses are left alone — no work happens inside them to attribute.
  if (options.routes && typeof options.routes === 'object') {
    const routes: Record<string, any> = {}
    for (const [route, value] of Object.entries<any>(options.routes)) {
      if (typeof value === 'function') {
        routes[route] = wrapHandler(value, normalize)
      } else if (value && typeof value === 'object' && !(value instanceof Response)) {
        const perMethod: Record<string, any> = { ...value }
        for (const [m, h] of Object.entries<any>(value)) {
          if (typeof h === 'function') perMethod[m] = wrapHandler(h, normalize)
        }
        routes[route] = perMethod
      } else {
        routes[route] = value
      }
    }
    out.routes = routes
  }
  return out
}

/** Wrap one request handler in a trace. Mirrors server-patch.ts semantics:
 *  name is `${METHOD} ${normalizedPath}` from the *actual* URL (never a route
 *  pattern), and the response status is preserved on the trace.
 *
 *  When the trace closes is the part that must match Node, not the naive
 *  reading of "handler done". Node closes on `res` 'close' — after the last
 *  body byte. Closing at handler resolution instead breaks the product's
 *  headline case: a streaming chat route returns its Response in milliseconds
 *  and then runs the whole agent loop *inside* the response stream, so every
 *  LLM call after the return fell outside the trace and rendered as an
 *  individual untraced row (observed against a real LangGraph backend). So:
 *  a Response whose body is a stream of unknown length keeps its trace open
 *  until the body completes or the client disconnects; everything else closes
 *  at resolution. The stale sweep remains the backstop for streams that never
 *  end. A handler that returns undefined (WebSocket upgrade) closes with null
 *  status. Thrown/rejected handlers close with null too — Bun decides the wire
 *  status after us, and guessing 500 would record a claim burn0 didn't observe. */
function wrapHandler(handler: (...a: any[]) => any, normalize: (p: string) => string) {
  const wrapped = function (this: any, req: Request, ...rest: any[]) {
    let trace: PendingTrace
    try {
      trace = openTrace(traceName(req, normalize), 'http-server')
    } catch {
      return handler.call(this, req, ...rest)
    }
    const done = (status: number | null) => { try { closeTrace(trace.localId, status) } catch {} }
    const settle = (res: any): any => {
      const status = typeof res?.status === 'number' ? res.status : null
      try {
        const deferred = deferCloseToBodyEnd(res, () => done(status))
        if (deferred) return deferred
      } catch {}
      done(status)
      return res
    }

    let result: any
    try {
      result = runInTrace(trace, () => handler.call(this, req, ...rest))
    } catch (err) {
      done(null)
      throw err
    }
    if (result && typeof result.then === 'function') {
      return result.then(settle, (err: unknown) => { done(null); throw err })
    }
    return settle(result)
  }
  ;(wrapped as any)[PATCHED] = true
  return wrapped
}

/** If the response body may stream (a ReadableStream with no declared
 *  content-length), replace it with a pump that closes the trace when the last
 *  chunk is through or the client cancels, and return the replacement Response.
 *  Returns null when there is nothing to wait for — no body, a fixed-length
 *  body (Bun.file and friends keep their sendfile fast path), or an already
 *  locked stream — in which case the caller closes immediately.
 *
 *  The pump is a manual reader loop rather than pipeThrough(TransformStream):
 *  TransformStream has no cancel hook, and a client disconnect is exactly the
 *  case that must still close the trace (the same reason the Node patch
 *  listens for 'close' beside 'finish'). Backpressure is preserved — pull only
 *  reads when the consumer asks. */
function deferCloseToBodyEnd(res: any, onDone: () => void): Response | null {
  if (!res || !(res instanceof Response)) return null
  const body = res.body
  if (!body || typeof body.getReader !== 'function') return null
  if (body.locked) return null
  if (res.headers?.get?.('content-length') != null) return null

  const reader = body.getReader()
  let closed = false
  const finish = () => { if (!closed) { closed = true; onDone() } }
  const pumped = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) { controller.close(); finish() } else { controller.enqueue(value) }
      } catch (err) {
        finish()
        controller.error(err)
      }
    },
    cancel(reason) {
      finish()
      try { return reader.cancel(reason) } catch {}
    },
  })
  // Response(body, res) copies status, statusText and headers per the fetch spec.
  return new Response(pumped, res)
}

function traceName(req: Request, normalize: (p: string) => string): string | null {
  try {
    const url = new URL(req.url)
    return `${String(req.method ?? 'GET').toUpperCase()} ${normalize(url.pathname)}`
  } catch {
    return null
  }
}
