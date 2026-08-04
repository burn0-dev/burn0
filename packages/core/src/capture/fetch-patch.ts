import { captureStackSnippet } from './stack.js'
import { currentTags } from '../context/index.js'
import { takeTraceStep } from '../context/trace.js'
import { collectStream } from './collect.js'
import { runMarked } from './dedup.js'
import type { CaptureEvent } from '../types.js'

export type EmitFn = (event: CaptureEvent, isSSE: boolean) => void
export interface CaptureOpts { ignoreHosts: string[]; bodyCapBytes: number }

export function hostIgnored(hostname: string, patterns: string[]): boolean {
  return patterns.some((p) =>
    p.startsWith('*.') ? hostname.endsWith(p.slice(1)) || hostname === p.slice(2) : hostname === p)
}

function headersToRecord(h: Headers | Record<string, any> | string[][] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (!h) return out
    if (h instanceof Headers) { h.forEach((v, k) => { out[k] = v }); return out }
    if (Array.isArray(h)) { for (const [k, v] of h) out[k] = String(v); return out }
    for (const [k, v] of Object.entries(h)) out[k] = String(v)
  } catch {}
  return out
}

export function patchFetch(emit: EmitFn, opts: CaptureOpts): () => void {
  const original = globalThis.fetch
  const safeEmit: EmitFn = (e, sse) => { try { emit(e, sse) } catch {} }

  globalThis.fetch = async function burn0Fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Anything that throws in our pre/post logic must not affect the app call.
    let url: URL | null = null
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    } catch {}
    if (!url || hostIgnored(url.hostname, opts.ignoreHosts)) {
      return runMarked(() => original(input, init))
    }

    const startedAt = Date.now()
    let stackSnippet: string | null
    let tags: Record<string, string> | null
    let method: string
    let reqHeaders: Record<string, string>
    let reqBody: string | null
    let reqBytes: number | null
    let trace: ReturnType<typeof takeTraceStep>
    try {
      stackSnippet = captureStackSnippet()
      tags = currentTags()
      trace = takeTraceStep()
      method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
      reqHeaders = headersToRecord(init?.headers as any ?? (typeof input === 'object' && 'headers' in input ? (input as Request).headers : undefined))
      reqBody = typeof init?.body === 'string' ? init.body : null
      // byte length, not char length — 'é' is one char and two bytes.
      // A non-string body (stream, FormData, Blob) is unmeasured, not empty.
      reqBytes = reqBody != null ? Buffer.byteLength(reqBody) : init?.body == null ? 0 : null
    } catch {
      // pre-processing must never block the app's request
      return runMarked(() => original(input, init))
    }

    let response: Response
    try {
      response = await runMarked(() => original(input, init))
    } catch (err) {
      // network failure: record it, then rethrow untouched
      safeEmit({
        startedAt, method, url: url.href, hostname: url.hostname, status: null,
        firstByteMs: null, latencyMs: Date.now() - startedAt,
        reqBytes, resBytes: 0,   // no response arrived: zero bytes is a fact
        reqHeaders, resHeaders: {}, reqBody, resBody: null,
        stackSnippet, tags, trace, estimated: false,
      }, false)
      throw err
    }

    try {
      const firstByteMs = Date.now() - startedAt
      const resHeaders = headersToRecord(response.headers)
      const base = {
        startedAt, method, url: url.href, hostname: url.hostname, status: response.status,
        firstByteMs, reqBytes,
        reqHeaders, resHeaders, reqBody, stackSnippet, tags, trace, estimated: false,
      }
      const contentType = response.headers.get('content-type') ?? ''

      if (contentType.includes('text/event-stream') && response.body) {
        const [forApp, forBurn0] = response.body.tee()
        collectStream(forBurn0, opts.bodyCapBytes).then(({ text: raw, truncated }) => {
          safeEmit({ ...base, latencyMs: Date.now() - startedAt, resBytes: Buffer.byteLength(raw), resBody: raw, estimated: truncated || raw.length === 0 }, true)
        }).catch(() => {
          safeEmit({ ...base, latencyMs: Date.now() - startedAt, resBytes: null, resBody: null, estimated: true }, true)
        })
        return new Response(forApp, { status: response.status, statusText: response.statusText, headers: response.headers })
      }

      // Non-stream: clone and read async; app gets original response immediately
      response.clone().text().then((text) => {
        safeEmit({ ...base, latencyMs: Date.now() - startedAt, resBytes: Buffer.byteLength(text), resBody: text }, false)
      }).catch(() => {
        safeEmit({ ...base, latencyMs: Date.now() - startedAt, resBytes: null, resBody: null }, false)
      })
      return response
    } catch {
      return response  // burn0 post-processing failed: app still gets its response
    }
  }

  return () => { globalThis.fetch = original }
}
