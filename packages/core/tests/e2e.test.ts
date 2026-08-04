import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBurn0, query, type Burn0Handle } from '../src/index.js'
import { withTags } from '../src/context/index.js'

let server: Server
let port: number
let handle: Burn0Handle

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/llm') {
      res.setHeader('content-type', 'application/json')
      res.end('{"model":"gpt-4o","usage":{"prompt_tokens":10,"completion_tokens":5}}')
    } else if (req.url === '/sse') {
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
      res.end('data: {"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n')
    } else {
      res.end('ok')
    }
  })
  await new Promise<void>((r) => server.listen(0, () => r()))
  port = (server.address() as any).port
  const dir = mkdtempSync(join(tmpdir(), 'burn0-e2e-'))
  handle = initBurn0({ env: { BURN0_DB_PATH: join(dir, 'burn0.db') } })!
})
afterAll(() => { handle.shutdown(); server.close() })

describe('end to end', () => {
  it('captures fetch + http clients, redacts, tags, and aggregates', async () => {
    // fetch with secret header + tag context
    await withTags({ feature: 'chat' }, async () => {
      await (await fetch(`http://127.0.0.1:${port}/llm`, {
        method: 'POST', headers: { authorization: 'Bearer sk-supersecret12345' }, body: '{"model":"gpt-4o"}',
      })).text()
    })
    // raw http client
    await new Promise<void>((resolve) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/plain' }, (res) => {
        res.on('data', () => {}); res.on('end', () => resolve())
      }); r.end()
    })
    // SSE stream fully readable by app
    const sseText = await (await fetch(`http://127.0.0.1:${port}/sse`)).text()
    expect(sseText).toContain('prompt_tokens')

    await new Promise((r) => setTimeout(r, 150))
    handle.queue.flushNow()

    const rows = handle.db.prepare('SELECT * FROM requests ORDER BY id').all()
    expect(rows.length).toBeGreaterThanOrEqual(3)

    const llmRow = rows.find((r: any) => r.url.endsWith('/llm'))
    expect(llmRow.model).toBe('gpt-4o')
    expect(llmRow.tokens_in).toBe(10)
    expect(JSON.parse(llmRow.tags)).toEqual({ feature: 'chat' })

    const payload = handle.db.prepare('SELECT * FROM payloads WHERE request_id = ?').get(llmRow.id)
    expect(JSON.parse(payload.req_headers).authorization).toBe('[redacted]')

    const sseRow = rows.find((r: any) => r.url.endsWith('/sse'))
    expect(sseRow.tokens_in).toBe(4)

    const o = query.overview(handle.db)
    expect(o.totalCalls).toBeGreaterThanOrEqual(3)
  })
})
