import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBurn0, withTrace, type Burn0Handle } from '../src/index.js'

/** The §2.6 payoff, proven end to end: one inbound request, and the LLM *and*
 *  API calls it produced, grouped under it in order. */

let upstream: Server           // stands in for OpenAI / Pinecone / Stripe
let app: Server                // the instrumented app
let upstreamPort: number
let appPort: number
let handle: Burn0Handle

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.setHeader('content-type', 'application/json')
      res.end('{"model":"gpt-4o","usage":{"prompt_tokens":1204,"completion_tokens":380}}')
    } else {
      res.end('{"ok":true}')
    }
  })
  await new Promise<void>((r) => upstream.listen(0, () => r()))
  upstreamPort = (upstream.address() as any).port

  const dir = mkdtempSync(join(tmpdir(), 'burn0-trace-e2e-'))
  handle = initBurn0({ env: { BURN0_DB_PATH: join(dir, 'burn0.db') } })!

  // Patched *after* burn0 init, exactly as a real app's server would be.
  app = createServer(async (req, res) => {
    if (req.url === '/api/chat') {
      await fetch(`http://127.0.0.1:${upstreamPort}/v1/chat/completions`, { method: 'POST', body: '{}' })
        .then((r) => r.text())
      await fetch(`http://127.0.0.1:${upstreamPort}/query`, { method: 'POST', body: '{}' }).then((r) => r.text())
      await fetch(`http://127.0.0.1:${upstreamPort}/v1/customers/42`).then((r) => r.text())
    } else if (req.url === '/api/nested') {
      await withTrace('retrieve-context', async () => {
        await fetch(`http://127.0.0.1:${upstreamPort}/query`, { method: 'POST', body: '{}' }).then((r) => r.text())
      })
      await withTrace('answer', async () => {
        await fetch(`http://127.0.0.1:${upstreamPort}/v1/chat/completions`, { method: 'POST', body: '{}' })
          .then((r) => r.text())
      })
    }
    res.end('done')
  })
  await new Promise<void>((r) => app.listen(0, () => r()))
  appPort = (app.address() as any).port
}, 20_000)

afterAll(() => { handle.shutdown(); app.close(); upstream.close() })

const settle = () => new Promise((r) => setTimeout(r, 300))

describe('auto-rooted traces, end to end', () => {
  it('groups an inbound request with the outbound calls it caused, in order', async () => {
    await fetch(`http://127.0.0.1:${appPort}/api/chat`).then((r) => r.text())
    await settle()
    handle.queue.flushNow()

    const trace = handle.db.prepare(
      `SELECT * FROM traces WHERE name = 'POST /api/chat' OR name = 'GET /api/chat'`).get()
    expect(trace).toBeDefined()
    expect(trace.kind).toBe('http-server')
    expect(trace.status).toBe(200)
    expect(trace.ended_at).toBeGreaterThanOrEqual(trace.started_at)

    const steps = handle.db.prepare(
      `SELECT seq, hostname, normalized_endpoint AS ep, entity_class AS cls, tokens_in AS tin
       FROM requests WHERE trace_id = ? ORDER BY seq`).all(trace.id)
    expect(steps.map((s: any) => s.seq)).toEqual([0, 1, 2])
    expect(steps.map((s: any) => s.ep)).toEqual(['/v1/chat/completions', '/query', '/v1/customers/:id'])
    // One token-reporting completion and two plain API calls, interleaved under
    // a single inbound request — the second half is what LangSmith structurally
    // cannot show. (The upstream here is 127.0.0.1, so `entity_class` is
    // 'general' for all three; the token counts are what identify the LLM call.)
    expect(steps.map((s: any) => s.tin)).toEqual([1204, null, null])
  })

  it('records a run for the process, and links every request to it', async () => {
    handle.queue.flushNow()
    const run = handle.db.prepare(`SELECT * FROM runs`).get()
    expect(run.pid).toBe(process.pid)
    expect(run.node_version).toBe(process.version)
    const orphans = handle.db.prepare(`SELECT COUNT(*) c FROM requests WHERE run_id IS NULL`).get().c
    expect(orphans).toBe(0)
  })

  it('nests explicit withTrace under the auto-rooted request', async () => {
    await fetch(`http://127.0.0.1:${appPort}/api/nested`).then((r) => r.text())
    await settle()
    handle.queue.flushNow()

    const root = handle.db.prepare(
      `SELECT * FROM traces WHERE name LIKE '%/api/nested'`).get()
    const children = handle.db.prepare(
      `SELECT * FROM traces WHERE parent_id = ? ORDER BY id`).all(root.id)
    expect(children.map((c: any) => c.name)).toEqual(['retrieve-context', 'answer'])
    expect(children.every((c: any) => c.kind === 'explicit')).toBe(true)

    // one seq counter across the whole subtree, so the tree sorts on seq alone
    const seqs = handle.db.prepare(
      `SELECT seq FROM requests WHERE trace_id IN (?, ?) ORDER BY seq`).all(children[0].id, children[1].id)
    expect(seqs.map((s: any) => s.seq)).toEqual([0, 1])
  })
})
