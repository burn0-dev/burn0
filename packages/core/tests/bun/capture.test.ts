import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBurn0, type Burn0Handle } from '../../src/init.js'

/** Outbound capture under Bun: the patched global fetch.
 *
 *  Mock upstreams are created BEFORE initBurn0 so they stay unwrapped — an
 *  in-process mock is a real inbound request, and wrapping it would invent
 *  traces the test never asked for (the same lesson the Node demo learned;
 *  see progress.md "mock vendors now run in a separate process"). */

let handle: Burn0Handle | null = null
const servers: any[] = []

function mockJson(body: unknown, headers: Record<string, string> = {}): any {
  const s = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', ...headers },
    }),
  })
  servers.push(s)
  return s
}

function freshInit(): Burn0Handle {
  const dir = mkdtempSync(join(tmpdir(), 'burn0-buncap-'))
  const h = initBurn0({ env: { BURN0_DB_PATH: join(dir, 'burn0.db') } })
  if (!h) throw new Error('initBurn0 returned null under Bun')
  handle = h
  return h
}

afterEach(() => {
  handle?.shutdown()
  handle = null
  while (servers.length) { try { servers.pop().stop(true) } catch {} }
})

describe('initBurn0 under Bun', () => {
  it('does not disable itself: returns a live handle and a real database', () => {
    const h = freshInit()
    expect(h.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()).toBeDefined()
  })
  it('keeps NODE_ENV=production / BURN0_FORCE semantics', () => {
    expect(initBurn0({ env: { NODE_ENV: 'production' } })).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'burn0-bunforce-'))
    const h = initBurn0({ env: { NODE_ENV: 'production', BURN0_FORCE: '1', BURN0_DB_PATH: join(dir, 'burn0.db') } })
    expect(h).not.toBeNull()
    h!.shutdown()
  })
  it('BURN0_DISABLED=1 still wins', () => {
    expect(initBurn0({ env: { BURN0_DISABLED: '1' } })).toBeNull()
  })
})

describe('Bun global fetch capture', () => {
  it('captures a JSON LLM response with model, token usage, and intact app body', async () => {
    const llm = mockJson({
      id: 'chatcmpl-1', model: 'gpt-4o-2024-08-06',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 120, completion_tokens: 34 },
    })
    const h = freshInit()

    const res = await fetch(`http://127.0.0.1:${llm.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-2024-08-06', messages: [] }),
    })
    // App behavior preserved: status, headers, body all readable as normal.
    expect(res.status).toBe(200)
    const appBody = await res.json() as any
    expect(appBody.choices[0].message.content).toBe('hi')

    await Bun.sleep(100)
    h.queue.flushNow()
    const row = h.db.prepare(`SELECT * FROM requests WHERE url LIKE '%/v1/chat/completions'`).get()
    expect(row).toBeDefined()
    expect(row.status).toBe(200)
    expect(row.model).toBe('gpt-4o-2024-08-06')
    expect(row.tokens_in).toBe(120)
    expect(row.tokens_out).toBe(34)
  })

  it('captures a Request-object call and a network failure without breaking either', async () => {
    const api = mockJson({ ok: true })
    const h = freshInit()

    await fetch(new Request(`http://127.0.0.1:${api.port}/v2/things`, { method: 'PUT' }))
    let threw = false
    try { await fetch('http://127.0.0.1:1/unreachable') } catch { threw = true }
    expect(threw).toBe(true)     // the app still sees its error, untouched

    await Bun.sleep(100)
    h.queue.flushNow()
    expect(h.db.prepare(`SELECT method FROM requests WHERE url LIKE '%/v2/things'`).get().method).toBe('PUT')
    const failed = h.db.prepare(`SELECT status FROM requests WHERE url LIKE '%/unreachable'`).get()
    expect(failed).toBeDefined()
    expect(failed.status).toBeNull()
  })

  it('SSE: app stream stays fully readable; final usage is extracted (Anthropic shape)', async () => {
    const frames = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":57}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"hel"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"lo"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
      'data: [DONE]\n\n',
    ]
    const sse = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({
        start(c) {
          for (const f of frames) c.enqueue(new TextEncoder().encode(f))
          c.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    })
    servers.push(sse)
    const h = freshInit()

    const res = await fetch(`http://127.0.0.1:${sse.port}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5' }) })
    const text = await res.text()
    // The application's branch of the tee carries every byte.
    expect(text).toBe(frames.join(''))

    await Bun.sleep(150)
    h.queue.flushNow()
    const row = h.db.prepare(`SELECT * FROM requests WHERE url LIKE '%/v1/messages'`).get()
    expect(row).toBeDefined()
    expect(row.model).toBe('claude-sonnet-5')
    expect(row.tokens_in).toBe(57)
    expect(row.tokens_out).toBe(9)
  })
})
