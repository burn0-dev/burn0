import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { patchHttp } from '../src/capture/http-patch.js'
import type { CaptureEvent } from '../src/types.js'

let server: Server
let port: number

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ echoed: body || null }))
    })
  })
  await new Promise<void>((r) => server.listen(0, () => r()))
  port = (server.address() as any).port
})
afterAll(() => server.close())

function doRequest(path: string, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET' }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('patchHttp', () => {
  it('captures request and response through http.request', async () => {
    const events: CaptureEvent[] = []
    const unpatch = patchHttp((e) => events.push(e), { ignoreHosts: [], bodyCapBytes: 1048576 })
    try {
      const res = await doRequest('/v1/things/42', '{"a":1}')
      expect(JSON.parse(res).echoed).toBe('{"a":1}')     // app response intact
      await new Promise((r) => setTimeout(r, 50))
      expect(events.length).toBe(1)
      expect(events[0].method).toBe('POST')
      expect(events[0].url).toBe(`http://127.0.0.1:${port}/v1/things/42`)
      expect(events[0].status).toBe(200)
      expect(events[0].reqBody).toBe('{"a":1}')
      expect(events[0].resBody).toContain('echoed')
    } finally { unpatch() }
  })

  it('respects ignoreHosts', async () => {
    const events: CaptureEvent[] = []
    const unpatch = patchHttp((e) => events.push(e), { ignoreHosts: ['127.0.0.1'], bodyCapBytes: 1048576 })
    try {
      await doRequest('/x')
      await new Promise((r) => setTimeout(r, 50))
      expect(events.length).toBe(0)
    } finally { unpatch() }
  })

  it('unpatch restores originals', async () => {
    const events: CaptureEvent[] = []
    const unpatch = patchHttp((e) => events.push(e), { ignoreHosts: [], bodyCapBytes: 1048576 })
    unpatch()
    await doRequest('/x')
    await new Promise((r) => setTimeout(r, 50))
    expect(events.length).toBe(0)
  })
})
