import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initBurn0, type Burn0Handle } from '../../src/init.js'

/** Inbound auto-rooting under Bun: the Bun.serve wrap.
 *
 *  Order matters everywhere here: mock upstreams start before initBurn0 (so
 *  their inbound side is unwrapped and invents no traces); the app server
 *  starts after (so its handler is wrapped). The test client's own calls to
 *  the app are captured as ordinary untraced outbound rows — assertions filter
 *  on trace_id to keep them out of the way. */

let handle: Burn0Handle | null = null
const servers: any[] = []

function track<T extends { stop: (b?: boolean) => void }>(s: T): T { servers.push(s); return s }

function freshInit(): Burn0Handle {
  const dir = mkdtempSync(join(tmpdir(), 'burn0-bunsrv-'))
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

async function settle(h: Burn0Handle): Promise<void> {
  await Bun.sleep(150)
  h.queue.flushNow()
}

describe('Bun inbound trace roots', () => {
  it('one inbound request creates one closed http-server trace, name normalized, status preserved', async () => {
    const h = freshInit()
    const app = track(Bun.serve({
      port: 0,
      fetch: async () => new Response('created', { status: 201 }),
    }))
    await (await fetch(`http://127.0.0.1:${app.port}/api/users/48213/notes`, { method: 'POST' })).text()
    await settle(h)

    const t = h.db.prepare(`SELECT * FROM traces WHERE kind = 'http-server'`).all()
    expect(t.length).toBe(1)
    expect(t[0].name).toBe('POST /api/users/:id/notes')   // real URL, normalized — never a hardcoded route
    expect(t[0].status).toBe(201)
    expect(t[0].ended_at).not.toBeNull()
  })

  it('outbound calls inside the handler share the trace id, in seq order', async () => {
    const upstream = track(Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) }))
    const h = freshInit()
    const app = track(Bun.serve({
      port: 0,
      fetch: async () => {
        await (await fetch(`http://127.0.0.1:${upstream.port}/first`)).text()
        await (await fetch(`http://127.0.0.1:${upstream.port}/second`)).text()
        await (await fetch(`http://127.0.0.1:${upstream.port}/third`)).text()
        return new Response('ok')
      },
    }))
    await (await fetch(`http://127.0.0.1:${app.port}/work/991`)).text()
    await settle(h)

    const trace = h.db.prepare(`SELECT * FROM traces WHERE kind = 'http-server'`).get()
    expect(trace.name).toBe('GET /work/:id')
    const rows = h.db.prepare(
      `SELECT url, seq, trace_id FROM requests WHERE trace_id IS NOT NULL ORDER BY seq`).all()
    expect(rows.length).toBe(3)
    expect(rows.map((r: any) => r.trace_id)).toEqual([trace.id, trace.id, trace.id])
    expect(rows.map((r: any) => r.seq)).toEqual([0, 1, 2])
    expect(rows.map((r: any) => new URL(r.url).pathname)).toEqual(['/first', '/second', '/third'])
  })

  it('routes option handlers and per-method maps are wrapped too', async () => {
    const h = freshInit()
    const app = track(Bun.serve({
      port: 0,
      routes: {
        '/health': new Response('ok'),                       // static: untouched
        '/jobs/:id': { POST: async () => Response.json({ queued: true }) },
      },
      fetch: () => new Response('fallback', { status: 404 }),
    }))
    await (await fetch(`http://127.0.0.1:${app.port}/jobs/777`, { method: 'POST' })).text()
    await settle(h)
    const t = h.db.prepare(`SELECT name, status FROM traces WHERE kind = 'http-server'`).all()
    expect(t.length).toBe(1)
    expect(t[0].name).toBe('POST /jobs/:id')
    expect(t[0].status).toBe(200)
  })

  it('a throwing handler still closes its trace and the client still gets Bun error handling', async () => {
    const h = freshInit()
    const app = track(Bun.serve({
      port: 0,
      fetch: async () => { throw new Error('boom') },
      error: () => new Response('handled', { status: 500 }),
    }))
    const res = await fetch(`http://127.0.0.1:${app.port}/explode`)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('handled')
    await settle(h)
    const t = h.db.prepare(`SELECT * FROM traces WHERE kind = 'http-server'`).get()
    expect(t).toBeDefined()
    expect(t.ended_at).not.toBeNull()   // closed, not leaked into the live map
  })
})

describe('streaming agent loop — calls made after the handler returned', () => {
  it('keeps the trace open until the response stream ends; late LLM calls stay inside it', async () => {
    // The observed real-world failure shape: a chat route returns its SSE
    // Response in milliseconds, then runs the agent loop *inside* the stream.
    // With close-at-handler-resolve, every one of those calls rendered as an
    // individual untraced row. The trace must close at body end instead.
    const llm = track(Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json().catch(() => ({})) as any
        return Response.json({
          model: body?.model ?? 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: 20 },
        })
      },
    }))
    const h = freshInit()

    const encoder = new TextEncoder()
    const app = track(Bun.serve({
      port: 0,
      fetch: async () => {
        // Handler resolves immediately; the work happens while streaming.
        const stream = new ReadableStream({
          async start(c) {
            for (let turn = 0; turn < 2; turn++) {
              await Bun.sleep(40)                       // well after the handler returned
              await (await fetch(`http://127.0.0.1:${llm.port}/v1/messages`, {
                method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5' }),
              })).json()
              c.enqueue(encoder.encode(`data: turn-${turn}\n\n`))
            }
            c.close()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      },
    }))

    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${app.port}/api/threads/5512/run`, { method: 'POST' })
    const text = await res.text()                        // app/client stream intact, fully readable
    expect(text).toBe('data: turn-0\n\ndata: turn-1\n\n')
    const streamedMs = Date.now() - started

    await settle(h)
    const trace = h.db.prepare(`SELECT * FROM traces WHERE kind = 'http-server'`).get()
    expect(trace.name).toBe('POST /api/threads/:id/run')
    expect(trace.status).toBe(200)
    // Closed at stream end, not at handler resolution: the trace spans the loop.
    expect(trace.ended_at - trace.started_at).toBeGreaterThanOrEqual(60)
    expect(trace.ended_at - trace.started_at).toBeLessThanOrEqual(streamedMs + 50)

    const calls = h.db.prepare(
      `SELECT trace_id, seq, model FROM requests WHERE url LIKE '%/v1/messages' ORDER BY seq`).all()
    expect(calls.length).toBe(2)
    expect(calls.map((c: any) => c.trace_id)).toEqual([trace.id, trace.id])   // NOT individual traces
    expect(calls.map((c: any) => c.seq)).toEqual([0, 1])
    expect(calls[0].model).toBe('claude-sonnet-5')
  })

  it('client disconnect mid-stream still closes the trace', async () => {
    const h = freshInit()
    const app = track(Bun.serve({
      port: 0,
      fetch: async () => new Response(new ReadableStream({
        pull: async (c) => { await Bun.sleep(20); c.enqueue(new TextEncoder().encode('data: tick\n\n')) },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    }))
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${app.port}/api/live`, { signal: controller.signal })
    const reader = res.body!.getReader()
    await reader.read()                                  // stream is live
    controller.abort()                                   // client walks away
    await Bun.sleep(250)
    h.queue.flushNow()
    const t = h.db.prepare(`SELECT ended_at FROM traces WHERE kind = 'http-server'`).get()
    expect(t).toBeDefined()
    expect(t.ended_at).not.toBeNull()                    // closed by cancel, not leaked
  })
})

describe('Hono on Bun — the target shape, end to end', () => {
  it('one chat-style request → one trace: LLM call, ordinary API call, final LLM call, in order', async () => {
    // Mock vendors, pre-init so their inbound side stays out of the data.
    const llm = track(Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json().catch(() => ({})) as any
        return Response.json({
          model: body?.model ?? 'gpt-4o', choices: [{ message: { content: 'answer' } }],
          usage: { prompt_tokens: 200, completion_tokens: 50 },
        })
      },
    }))
    const vendor = track(Bun.serve({ port: 0, fetch: () => Response.json({ rows: [1, 2] }) }))

    const h = freshInit()

    // A realistic Hono app: default-export shape, param route, async handler.
    // The route name is the test's own — burn0 must derive it, not know it.
    const hono = new Hono()
    hono.post('/v1/support/:ticketId/reply', async (c) => {
      const call = (path: string, body: unknown) => fetch(`http://127.0.0.1:${llm.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }).then((r) => r.json())
      await call('/v1/chat/completions', { model: 'gpt-4o', messages: [] })
      await (await fetch(`http://127.0.0.1:${vendor.port}/crm/lookup`)).json()
      const final = await call('/v1/chat/completions', { model: 'gpt-4o', messages: [] }) as any
      return c.json({ reply: final.choices[0].message.content })
    })
    const app = track(Bun.serve({ port: 0, fetch: hono.fetch }))

    const res = await fetch(`http://127.0.0.1:${app.port}/v1/support/88231/reply`, { method: 'POST' })
    expect((await res.json() as any).reply).toBe('answer')
    await settle(h)

    const trace = h.db.prepare(`SELECT * FROM traces WHERE kind = 'http-server'`).get()
    expect(trace).toBeDefined()
    expect(trace.name).toBe('POST /v1/support/:id/reply')
    expect(trace.status).toBe(200)

    const steps = h.db.prepare(
      `SELECT model, tokens_in, tokens_out, url FROM requests WHERE trace_id = ? ORDER BY seq`).all(trace.id)
    expect(steps.length).toBe(3)
    expect(steps[0].model).toBe('gpt-4o')          // LLM call
    expect(steps[0].tokens_in).toBe(200)
    expect(new URL(steps[1].url).pathname).toBe('/crm/lookup')   // ordinary API call between them
    expect(steps[1].model).toBeNull()
    expect(steps[2].model).toBe('gpt-4o')          // final LLM call
    expect(steps[2].tokens_out).toBe(50)
  })
})

describe('Anthropic SSE tool call + cache usage — cross-runtime parity (bun:sqlite)', () => {
  it('records the 🔧 tool trace and normalized cache tokens, identical to the Node path', async () => {
    // Same fixture shape as packages/core/tests/trace-e2e.test.ts: a declared
    // tool call (content_block_start + input_json_delta) plus usage split
    // across message_start (input + cache_read + cache_creation) and
    // message_delta (output).
    const sseFrames = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":30,"cache_read_input_tokens":200,"cache_creation_input_tokens":45}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bun_01","name":"search_orders","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"customer\\":\\"acme\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":12}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]
    const llm = track(Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({
        start(c) {
          for (const f of sseFrames) c.enqueue(new TextEncoder().encode(f))
          c.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    }))
    const h = freshInit()
    const app = track(Bun.serve({
      port: 0,
      fetch: async () => {
        await (await fetch(`http://127.0.0.1:${llm.port}/v1/messages`, {
          method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5' }),
        })).text()
        return new Response('ok')
      },
    }))

    await (await fetch(`http://127.0.0.1:${app.port}/api/agent`)).text()
    await settle(h)

    const root = h.db.prepare(`SELECT * FROM traces WHERE kind = 'http-server'`).get()
    expect(root).toBeDefined()
    expect(root.name).toBe('GET /api/agent')

    const tool = h.db.prepare(`SELECT * FROM traces WHERE kind = 'tool'`).get()
    expect(tool).toBeDefined()
    expect(tool.name).toBe('search_orders')
    expect(tool.parent_id).toBe(root.id)

    const req = h.db.prepare(
      `SELECT tokens_in, tokens_cached, tokens_cache_write FROM requests WHERE url LIKE '%/v1/messages'`).get()
    expect(req).toBeDefined()
    // Anthropic input excludes cache — normalized tokens_in = input + cache_read + cache_creation.
    expect(req.tokens_in).toBe(30 + 200 + 45)
    expect(req.tokens_cached).toBe(200)
    expect(req.tokens_cache_write).toBe(45)   // the assertion that matters most: bun:sqlite writes it too
  })
})
