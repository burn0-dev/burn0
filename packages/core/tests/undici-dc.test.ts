import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request as undiciRequest } from 'undici'
import { subscribeUndici } from '../src/capture/undici-dc.js'
import { patchFetch } from '../src/capture/fetch-patch.js'
import type { CaptureEvent } from '../src/types.js'

let server: Server
let port: number
beforeAll(async () => {
  server = createServer((_req, res) => { res.end('ok') })
  await new Promise<void>((r) => server.listen(0, () => r()))
  port = (server.address() as any).port
})
afterAll(() => server.close())

describe('subscribeUndici', () => {
  it('captures direct undici.request metadata', async () => {
    const events: CaptureEvent[] = []
    const unsub = subscribeUndici((e) => events.push(e), { ignoreHosts: [], bodyCapBytes: 1048576 })
    try {
      const { body, statusCode } = await undiciRequest(`http://127.0.0.1:${port}/direct`)
      await body.text()
      expect(statusCode).toBe(200)
      await new Promise((r) => setTimeout(r, 100))
      const hit = events.find((e) => e.url.includes('/direct'))
      expect(hit).toBeDefined()
      expect(hit!.method).toBe('GET')
      expect(hit!.status).toBe(200)
    } finally { unsub() }
  })

  it('does NOT double-record fetch handled by patched fetch', async () => {
    const dcEvents: CaptureEvent[] = []
    const fetchEvents: CaptureEvent[] = []
    const unsub = subscribeUndici((e) => dcEvents.push(e), { ignoreHosts: [], bodyCapBytes: 1048576 })
    const unpatch = patchFetch((e) => fetchEvents.push(e), { ignoreHosts: [], bodyCapBytes: 1048576 })
    try {
      await (await fetch(`http://127.0.0.1:${port}/via-fetch`)).text()
      await new Promise((r) => setTimeout(r, 100))
      expect(fetchEvents.filter((e) => e.url.includes('/via-fetch')).length).toBe(1)
      expect(dcEvents.filter((e) => e.url.includes('/via-fetch')).length).toBe(0)
    } finally { unpatch(); unsub() }
  })
})
