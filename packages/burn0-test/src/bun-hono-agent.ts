import { Hono } from 'hono'
import { startVendors } from './start-vendors.mjs'

// The Bun/Hono target backend (spec §2.0 widened to Bun): a Hono server on
// Bun.serve, an agent-shaped chat route, zero burn0 imports in application
// code. Instrumentation is the preload only:
//
//   BURN0_DB_PATH="/private/tmp/burn0-test.db" BURN0_FORCE=1 \
//   bun --import ../core/dist/register.mjs --watch src/bun-hono-agent.ts
//
// Mock vendors run in their own process, without burn0 — in-process mocks are
// real inbound requests and would each auto-root a trace of their own.

const vendors = await startVendors()
const json = (url: string, init?: RequestInit) => fetch(url, init).then((r) => r.text())

const app = new Hono()

// The agent turn: LLM declares a tool, the tool calls two APIs, results go
// back, the model answers. Deliberately a param route — the trace name must
// come out normalized from the real URL, never from a route pattern.
app.post('/api/conversations/:id/chat', async (c) => {
  await json(`${vendors.base}/declare-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'where is my order?' }] }),
  })
  await json(`${vendors.base}/query`, { method: 'POST', body: '{"top_k":3}' })
  await json(`${vendors.base}/v1/charges/ch_771`, {})
  await json(`${vendors.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'tool', tool_call_id: 'call_orders_1', content: '{"status":"shipped"}' }],
    }),
  })
  return c.json({ reply: 'Your order shipped on Tuesday.' })
})

// Streaming leg: the app consumes an SSE completion mid-request.
app.post('/api/conversations/:id/stream', async (c) => {
  const res = await fetch(`${vendors.base}/v1/chat/stream`, {
    method: 'POST', body: '{"model":"gpt-4o","stream":true}',
  })
  const body = await res.text()
  return c.json({ frames: body.split('\n\n').filter(Boolean).length })
})

export default { port: 3199, fetch: app.fetch }

console.log('bun-hono-agent listening on http://localhost:3199')
console.log('try:  curl -X POST http://localhost:3199/api/conversations/48213/chat')
