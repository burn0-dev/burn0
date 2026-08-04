import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withTrace } from '@burn0/core'

// `let` before first use: `startVendors` runs at module top level, and a `let`
// declared below it is in the temporal dead zone by then.
let vendors

// A long-running server backend — burn0's target user (spec §2.0). Each inbound
// request auto-roots a trace, and the outbound LLM and API calls it makes land
// under it in order. One route declares a tool call so §8's window attribution
// has something real to work on.

const vendorBase = await startVendors()

const json = (url, init) => fetch(url, init).then((r) => r.text())

const app = createServer(async (req, res) => {
  try {
    const path = (req.url ?? '/').split('?')[0]

    if (path === '/api/chat') {
      // the §2.6 shape: retrieve, answer, then a plain API call
      await json(`${vendorBase}/query`, { method: 'POST', body: '{"top_k":5}' })
      await json(`${vendorBase}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-demo-secret-key-12345' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'where is my order?' }] }),
      })
      await json(`${vendorBase}/v1/customers/cus_9182`, {})
    } else if (path === '/api/agent') {
      // the §8 shape: the model asks for a tool, the tool calls two APIs, the
      // results go back, the model answers
      await json(`${vendorBase}/declare-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'where is my order?' }] }),
      })
      await json(`${vendorBase}/query`, { method: 'POST', body: '{"top_k":3}' })
      await json(`${vendorBase}/v1/charges/ch_771`, {})
      await json(`${vendorBase}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'tool', tool_call_id: 'call_orders_1', content: '{"status":"shipped"}' }],
        }),
      })
    } else if (path === '/api/nested') {
      // hand-instrumented: withTrace is where real depth comes from
      await withTrace('retrieve-context', async () => {
        await json(`${vendorBase}/query`, { method: 'POST', body: '{"top_k":8}' })
        await json(`${vendorBase}/v1/chat/completions`, {
          method: 'POST', body: '{"model":"text-embedding-3-small"}',
        })
      })
      await withTrace('answer', async () => {
        await json(`${vendorBase}/v1/chat/stream`, { method: 'POST', body: '{"model":"gpt-4o","stream":true}' })
      })
    } else if (path === '/api/broken') {
      await fetch(`${vendorBase}/error`)
    }

    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(err) }))
  }
})

await new Promise((r) => app.listen(0, r))
const base = `http://127.0.0.1:${app.address().port}`

const routes = ['/api/chat', '/api/agent', '/api/nested', '/api/chat', '/api/broken', '/api/agent']
for (const route of routes) await json(`${base}${route}`, {})

// let the write queue drain before the process tears down
await new Promise((r) => setTimeout(r, 700))

console.log(`agent-server done: ${routes.length} inbound requests traced`)
console.log('  /api/chat    retrieve → answer → customer lookup')
console.log('  /api/agent   tool call with two API calls attributed to it')
console.log('  /api/nested  explicit withTrace nesting, one streaming response')
console.log('  /api/broken  upstream 500')
console.log('now run:  pnpm burn0')

app.close()
vendors.kill()

async function startVendors() {
  const script = fileURLToPath(new URL('./vendors.mjs', import.meta.url))
  vendors = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vendors did not start')), 5000)
    vendors.stdout.on('data', (chunk) => {
      const m = /PORT (\d+)/.exec(String(chunk))
      if (!m) return
      clearTimeout(timer)
      resolve(Number(m[1]))
    })
  })
  return `http://127.0.0.1:${port}`
}
