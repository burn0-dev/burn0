import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { captureStackSnippet } from './stack.js'
import { currentTags } from '../context/index.js'
import { isMarked } from './dedup.js'
import { hostIgnored, type EmitFn, type CaptureOpts } from './fetch-patch.js'

interface Pending {
  startedAt: number
  method: string
  url: URL
  reqHeaders: Record<string, string>
  stackSnippet: string | null
  tags: Record<string, string> | null
  status: number | null
  resHeaders: Record<string, string>
  firstByteMs: number | null
  skip: boolean
}

export function subscribeUndici(emit: EmitFn, opts: CaptureOpts): () => void {
  const pending = new WeakMap<object, Pending>()
  const safeEmit: EmitFn = (e, sse) => { try { emit(e, sse) } catch {} }

  const onCreate = (message: any) => {
    try {
      const req = message.request
      if (!req) return
      const url = new URL(req.origin ? `${req.origin}${req.path ?? '/'}` : req.path)
      pending.set(req, {
        startedAt: Date.now(),
        method: (req.method ?? 'GET').toUpperCase(),
        url,
        reqHeaders: parseRawHeaders(req.headers),
        stackSnippet: captureStackSnippet(),
        tags: currentTags(),
        status: null, resHeaders: {}, firstByteMs: null,
        skip: isMarked() || hostIgnored(url.hostname, opts.ignoreHosts),
      })
    } catch {}
  }

  const onHeaders = (message: any) => {
    try {
      const p = pending.get(message.request)
      if (!p) return
      p.firstByteMs = Date.now() - p.startedAt
      p.status = message.response?.statusCode ?? null
      p.resHeaders = parseRawHeaderPairs(message.response?.headers)
    } catch {}
  }

  const onDone = (message: any) => {
    try {
      const p = pending.get(message.request)
      if (!p || p.skip) return
      pending.delete(message.request)
      safeEmit({
        startedAt: p.startedAt, method: p.method, url: p.url.href, hostname: p.url.hostname,
        status: p.status, firstByteMs: p.firstByteMs, latencyMs: Date.now() - p.startedAt,
        reqBytes: 0, resBytes: 0,
        reqHeaders: p.reqHeaders, resHeaders: p.resHeaders,
        reqBody: null, resBody: null,
        stackSnippet: p.stackSnippet, tags: p.tags, estimated: false,
      }, false)
    } catch {}
  }

  subscribe('undici:request:create', onCreate)
  subscribe('undici:request:headers', onHeaders)
  subscribe('undici:request:trailers', onDone)

  return () => {
    unsubscribe('undici:request:create', onCreate)
    unsubscribe('undici:request:headers', onHeaders)
    unsubscribe('undici:request:trailers', onDone)
  }
}

function parseRawHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (typeof h === 'string') {
      for (const line of h.split('\r\n')) {
        const i = line.indexOf(':')
        if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
      }
    } else if (Array.isArray(h)) {
      for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1])
    } else if (h && typeof h === 'object') {
      for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v)
    }
  } catch {}
  return out
}

function parseRawHeaderPairs(h: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (Array.isArray(h)) {
      for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1])
    }
  } catch {}
  return out
}
