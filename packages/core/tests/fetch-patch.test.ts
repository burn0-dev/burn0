import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { patchFetch, hostIgnored } from '../src/capture/fetch-patch.js'
import { collectStream } from '../src/capture/collect.js'
import type { CaptureEvent } from '../src/types.js'

let server: Server
let port: number

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/json') {
      res.setHeader('content-type', 'application/json')
      res.end('{"usage":{"prompt_tokens":3,"completion_tokens":1},"model":"gpt-4o"}')
    } else if (req.url === '/utf8') {
      res.setHeader('content-type', 'application/json')
      res.end('{"a":"café→"}')
    } else if (req.url === '/sse') {
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      res.write('data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n')
      res.end('data: [DONE]\n\n')
    } else {
      res.statusCode = 404
      res.end('nope')
    }
  })
  await new Promise<void>((r) => server.listen(0, () => r()))
  port = (server.address() as any).port
})
afterAll(() => server.close())

function withPatched(run: (events: Array<{ e: CaptureEvent; sse: boolean }>) => Promise<void>) {
  return async () => {
    const events: Array<{ e: CaptureEvent; sse: boolean }> = []
    const unpatch = patchFetch((e, sse) => events.push({ e, sse }), { ignoreHosts: [], bodyCapBytes: 1048576 })
    try { await run(events) } finally { unpatch() }
  }
}

describe('patchFetch', () => {
  it('captures JSON request/response and metadata', withPatched(async (events) => {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-4o"}',
    })
    expect((await res.json()).model).toBe('gpt-4o')   // app response intact
    await new Promise((r) => setTimeout(r, 50))
    expect(events.length).toBe(1)
    const { e, sse } = events[0]
    expect(sse).toBe(false)
    expect(e.method).toBe('POST')
    expect(e.status).toBe(200)
    expect(e.reqBody).toBe('{"model":"gpt-4o"}')
    expect(e.resBody).toContain('prompt_tokens')
    expect(e.latencyMs).toBeGreaterThanOrEqual(0)
  }))

  it('tees SSE: app stream intact, usage captured, sse flag set', withPatched(async (events) => {
    const res = await fetch(`http://127.0.0.1:${port}/sse`)
    const text = await res.text()                      // app reads its branch fully
    expect(text).toContain('[DONE]')
    await new Promise((r) => setTimeout(r, 100))
    expect(events.length).toBe(1)
    expect(events[0].sse).toBe(true)
    expect(events[0].e.resBody).toContain('"prompt_tokens":7')
    expect(events[0].e.resBody).toContain('usage')
    expect(events[0].e.estimated).toBe(false)
  }))

  it('measures bytes, not characters', withPatched(async (events) => {
    // 'é' and '→' are one JS char but 2 and 3 UTF-8 bytes. String .length
    // under-reports every multibyte payload.
    const body = '{"q":"café→"}'
    await fetch(`http://127.0.0.1:${port}/utf8`, { method: 'POST', body })
    await new Promise((r) => setTimeout(r, 50))
    const { e } = events[0]
    expect(e.reqBytes).toBe(Buffer.byteLength(body))
    expect(e.reqBytes).toBeGreaterThan(body.length)
    expect(e.resBytes).toBe(Buffer.byteLength('{"a":"café→"}'))
    expect(e.resBytes).toBeGreaterThan('{"a":"café→"}'.length)
  }))

  it('ignores hosts matching ignoreHosts', async () => {
    const events: any[] = []
    const unpatch = patchFetch((e) => events.push(e), { ignoreHosts: ['127.0.0.1'], bodyCapBytes: 1048576 })
    try {
      await fetch(`http://127.0.0.1:${port}/json`)
      await new Promise((r) => setTimeout(r, 50))
      expect(events.length).toBe(0)
    } finally { unpatch() }
  })

  it('emit callback throwing never breaks the app request', async () => {
    const unpatch = patchFetch(() => { throw new Error('boom') }, { ignoreHosts: [], bodyCapBytes: 1048576 })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      expect(res.status).toBe(200)
    } finally { unpatch() }
  })
})

describe('hostIgnored', () => {
  it('exact and wildcard', () => {
    expect(hostIgnored('localhost', ['localhost'])).toBe(true)
    expect(hostIgnored('a.internal', ['*.internal'])).toBe(true)
    expect(hostIgnored('api.openai.com', ['localhost'])).toBe(false)
  })
})

describe('collectStream', () => {
  it('returns truncated=true with partial text when the stream errors mid-read', async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('partial-chunk'))
          return
        }
        throw new Error('boom mid-read')
      },
    })

    const result = await collectStream(stream, 1_048_576)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('partial-chunk')
  })
})
