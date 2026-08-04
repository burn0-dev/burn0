import http from 'node:http'
import https from 'node:https'
import { captureStackSnippet } from './stack.js'
import { currentTags } from '../context/index.js'
import { takeTraceStep } from '../context/trace.js'
import { hostIgnored, type EmitFn, type CaptureOpts } from './fetch-patch.js'

type RequestFn = typeof http.request

export function patchHttp(emit: EmitFn, opts: CaptureOpts): () => void {
  const originals = {
    httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get,
  }
  const safeEmit: EmitFn = (e, sse) => { try { emit(e, sse) } catch {} }
  const instrumented = new WeakSet<http.ClientRequest>()

  const wrap = (original: RequestFn, protocol: 'http:' | 'https:'): RequestFn =>
    function burn0Request(this: unknown, ...args: any[]) {
      const req = (original as any).apply(this, args)
      try {
        instrumented.add(req)
        instrument(req, args, protocol, safeEmit, opts)
      } catch {}
      return req
    } as RequestFn

  http.request = wrap(originals.httpRequest, 'http:')
  https.request = wrap(originals.httpsRequest, 'https:')
  http.get = ((...args: any[]) => { const r = (http.request as any)(...args); r.end(); return r }) as typeof http.get
  https.get = ((...args: any[]) => { const r = (https.request as any)(...args); r.end(); return r }) as typeof https.get

  // Fallback for requests created through a reference obtained before this
  // function ran (e.g. `import { request } from 'node:http'` snapshots the
  // original at module-load time — ESM named bindings for core CJS modules
  // are not live, so the reassignments above never run for those callers).
  // http.ClientRequest is the single class Node uses internally for both
  // http.request and https.request no matter which binding constructed it,
  // so hooking its prototype reaches every request regardless of import
  // style. Instances already handled above get an own `write`/`end`
  // property from `instrument()`, which shadows these prototype methods,
  // so there is no double-capture for the common path.
  const unpatchProto = patchClientRequestFallback(safeEmit, opts, instrumented)

  return () => {
    http.request = originals.httpRequest
    http.get = originals.httpGet
    https.request = originals.httpsRequest
    https.get = originals.httpsGet
    unpatchProto()
  }
}

function patchClientRequestFallback(emit: EmitFn, opts: CaptureOpts, instrumented: WeakSet<http.ClientRequest>): () => void {
  const proto = http.ClientRequest.prototype as any
  const origWrite = proto.write
  const origEnd = proto.end

  const hook = (req: http.ClientRequest) => {
    if (instrumented.has(req)) return
    instrumented.add(req)
    try { instrumentFallback(req, emit, opts) } catch {}
  }

  proto.write = function (this: http.ClientRequest, ...args: any[]) {
    hook(this)
    return origWrite.apply(this, args)
  }
  proto.end = function (this: http.ClientRequest, ...args: any[]) {
    hook(this)
    return origEnd.apply(this, args)
  }

  return () => { proto.write = origWrite; proto.end = origEnd }
}

// Same shape as instrument()'s response/error capture, but sourced entirely
// from the request instance's own public properties (method/path/host/
// protocol/getHeaders) instead of the original call args, since the
// fallback path never sees those args. Body content is intentionally not
// captured here (reqBody stays null): by the time we detect the instance
// via write()/end(), reliably intercepting every chunk would require
// re-deriving state this class already handles for the primary path, for
// a bypass case that has no data-capture requirement from callers.
function instrumentFallback(req: http.ClientRequest, emit: EmitFn, opts: CaptureOpts): void {
  const startedAt = Date.now()
  const stackSnippet = captureStackSnippet()
  const tags = currentTags()

  let url: URL
  try {
    const hostHeader = String(req.getHeader('host') ?? (req as any).host ?? 'localhost')
    const protocol = (req as any).protocol ?? 'http:'
    url = new URL(`${protocol}//${hostHeader}${req.path ?? '/'}`)
  } catch { return }
  if (hostIgnored(url.hostname, opts.ignoreHosts)) return
  // After the bail-outs: a call that is never recorded must not consume a seq,
  // or the trace's step numbers have holes in them.
  const trace = takeTraceStep()

  let emitted = false
  const emitOnce: EmitFn = (e, sse) => {
    if (emitted) return
    emitted = true
    emit(e, sse)
  }

  req.on('response', (res: http.IncomingMessage) => {
    try {
      const firstByteMs = Date.now() - startedAt
      const resChunks: string[] = []
      let resBytes = 0
      res.on('data', (chunk: Buffer) => {
        try {
          resBytes += chunk.length
          if (resBytes <= opts.bodyCapBytes + 65536) resChunks.push(chunk.toString('utf8'))
        } catch {}
      })
      res.on('end', () => {
        try {
          const contentType = String(res.headers['content-type'] ?? '')
          const isSSE = contentType.includes('text/event-stream')
          emitOnce({
            startedAt, method: (req.method ?? 'GET').toUpperCase(), url: url.href, hostname: url.hostname,
            status: res.statusCode ?? null, firstByteMs, latencyMs: Date.now() - startedAt,
            reqBytes: 0, resBytes,
            reqHeaders: flattenHeaders(req.getHeaders()), resHeaders: flattenHeaders(res.headers),
            reqBody: null, resBody: resChunks.length ? resChunks.join('') : null,
            stackSnippet, tags, trace, estimated: false,
          }, isSSE)
        } catch {}
      })
      res.on('error', () => {
        try {
          emitOnce({
            startedAt, method: (req.method ?? 'GET').toUpperCase(), url: url.href, hostname: url.hostname,
            status: res.statusCode ?? null, firstByteMs, latencyMs: Date.now() - startedAt,
            reqBytes: 0, resBytes,
            reqHeaders: flattenHeaders(req.getHeaders()), resHeaders: flattenHeaders(res.headers),
            reqBody: null, resBody: resChunks.length ? resChunks.join('') : null,
            stackSnippet, tags, trace, estimated: true,
          }, false)
        } catch {}
      })
    } catch {}
  })

  req.on('error', () => {
    try {
      emitOnce({
        startedAt, method: (req.method ?? 'GET').toUpperCase(), url: url.href, hostname: url.hostname,
        status: null, firstByteMs: null, latencyMs: Date.now() - startedAt,
        reqBytes: 0, resBytes: 0,
        reqHeaders: flattenHeaders(req.getHeaders()), resHeaders: {},
        reqBody: null, resBody: null,
        stackSnippet, tags, trace, estimated: false,
      }, false)
    } catch {}
  })
}

function instrument(req: http.ClientRequest, args: any[], protocol: string, emit: EmitFn, opts: CaptureOpts): void {
  const startedAt = Date.now()
  const stackSnippet = captureStackSnippet()
  const tags = currentTags()

  // Reconstruct URL from (url[, options]) or (options) call signatures
  let urlStr: string
  const a0 = args[0]
  if (typeof a0 === 'string') urlStr = a0
  else if (a0 instanceof URL) urlStr = a0.href
  else {
    const o = a0 ?? {}
    const host = o.hostname ?? o.host ?? 'localhost'
    const port = o.port ? `:${o.port}` : ''
    urlStr = `${o.protocol ?? protocol}//${host}${port}${o.path ?? '/'}`
  }
  let url: URL
  try { url = new URL(urlStr) } catch { return }
  if (hostIgnored(url.hostname, opts.ignoreHosts)) return
  // See instrumentFallback: the step is taken only once the call is certain
  // to be recorded.
  const trace = takeTraceStep()

  let emitted = false
  const emitOnce: EmitFn = (e, sse) => {
    if (emitted) return
    emitted = true
    emit(e, sse)
  }

  // capture request body via write/end interception
  const reqChunks: string[] = []
  let reqBytes = 0
  const origWrite = req.write.bind(req)
  const origEnd = req.end.bind(req)
  req.write = ((chunk: any, ...rest: any[]) => {
    try {
      if (chunk != null) {
        reqBytes += Buffer.byteLength(chunk)
        if (reqBytes <= opts.bodyCapBytes + 65536) reqChunks.push(String(chunk))
      }
    } catch {}
    return origWrite(chunk, ...rest)
  }) as any
  req.end = ((chunk?: any, ...rest: any[]) => {
    try {
      if (chunk != null && typeof chunk !== 'function') {
        reqBytes += Buffer.byteLength(chunk)
        if (reqBytes <= opts.bodyCapBytes + 65536) reqChunks.push(String(chunk))
      }
    } catch {}
    return origEnd(chunk, ...rest)
  }) as any

  req.on('response', (res: http.IncomingMessage) => {
    try {
      const firstByteMs = Date.now() - startedAt
      const resChunks: string[] = []
      let resBytes = 0
      res.on('data', (chunk: Buffer) => {
        try {
          resBytes += chunk.length
          if (resBytes <= opts.bodyCapBytes + 65536) resChunks.push(chunk.toString('utf8'))
        } catch {}
      })
      res.on('end', () => {
        try {
          const contentType = String(res.headers['content-type'] ?? '')
          const isSSE = contentType.includes('text/event-stream')
          emitOnce({
            startedAt, method: (req.method ?? 'GET').toUpperCase(), url: url.href, hostname: url.hostname,
            status: res.statusCode ?? null, firstByteMs, latencyMs: Date.now() - startedAt,
            reqBytes, resBytes,
            reqHeaders: flattenHeaders(req.getHeaders()), resHeaders: flattenHeaders(res.headers),
            reqBody: reqChunks.length ? reqChunks.join('') : null,
            resBody: resChunks.length ? resChunks.join('') : null,
            stackSnippet, tags, trace, estimated: false,
          }, isSSE)
        } catch {}
      })
      res.on('error', () => {
        try {
          emitOnce({
            startedAt, method: (req.method ?? 'GET').toUpperCase(), url: url.href, hostname: url.hostname,
            status: res.statusCode ?? null, firstByteMs, latencyMs: Date.now() - startedAt,
            reqBytes, resBytes,
            reqHeaders: flattenHeaders(req.getHeaders()), resHeaders: flattenHeaders(res.headers),
            reqBody: reqChunks.length ? reqChunks.join('') : null,
            resBody: resChunks.length ? resChunks.join('') : null,
            stackSnippet, tags, trace, estimated: true,
          }, false)
        } catch {}
      })
    } catch {}
  })

  req.on('error', () => {
    try {
      emitOnce({
        startedAt, method: (req.method ?? 'GET').toUpperCase(), url: url.href, hostname: url.hostname,
        status: null, firstByteMs: null, latencyMs: Date.now() - startedAt,
        reqBytes, resBytes: 0,
        reqHeaders: flattenHeaders(req.getHeaders()), resHeaders: {},
        reqBody: reqChunks.length ? reqChunks.join('') : null, resBody: null,
        stackSnippet, tags, trace, estimated: false,
      }, false)
    } catch {}
  })
}

function flattenHeaders(h: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const [k, v] of Object.entries(h)) {
      if (v == null) continue
      out[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }
  } catch {}
  return out
}
