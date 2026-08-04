import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import { patchServers, serverPrototypes } from '../src/capture/server-patch.js'
import { takeTraceStep, drainTraces, resetTraces, sweepStaleTraces, liveTraceCount } from '../src/context/trace.js'

let unpatch: (() => void) | null = null

beforeEach(() => { resetTraces() })
afterEach(() => { unpatch?.(); unpatch = null })

/** What an outbound capture path records when a call happens inside a handler. */
function stepInHandler(sink: Array<{ localId: number; seq: number } | null>) {
  return () => sink.push(takeTraceStep())
}

describe('serverPrototypes', () => {
  it('finds all four classes, and they are genuinely four different prototypes', () => {
    const protos = serverPrototypes()
    expect(protos.length).toBe(4)
    expect(new Set(protos.map((p) => p.proto)).size).toBe(4)
    expect(protos.map((p) => p.label).sort())
      .toEqual(['Http2SecureServer', 'Http2Server', 'http.Server', 'https.Server'])
  })

  it('reaches the HTTP/2 classes, which node:http2 does not export', () => {
    // measured on 22.12: http2.Http2Server is undefined — the prototypes are
    // only reachable through a throwaway instance
    expect((http2 as any).Http2Server).toBeUndefined()
    const found = serverPrototypes().find((p) => p.label === 'Http2Server')!
    expect(typeof found.proto.emit).toBe('function')
  })

  it('https.Server is not reachable by patching http.Server', () => {
    expect(https.Server.prototype instanceof http.Server).toBe(false)
  })
})

describe('patchServers', () => {
  it('wraps and restores emit on every class', () => {
    const before = serverPrototypes().map((p) => p.proto.emit)
    unpatch = patchServers()
    const during = serverPrototypes().map((p) => p.proto.emit)
    expect(during.every((fn, i) => fn !== before[i])).toBe(true)
    unpatch()
    unpatch = null
    expect(serverPrototypes().map((p) => p.proto.emit)).toEqual(before)
  })

  it('opens a trace per inbound request and attributes calls made inside the handler', async () => {
    unpatch = patchServers()
    const steps: Array<{ localId: number; seq: number } | null> = []
    const server = http.createServer((_req, res) => {
      stepInHandler(steps)()
      stepInHandler(steps)()
      res.end('ok')
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    const port = (server.address() as any).port
    await fetch(`http://127.0.0.1:${port}/api/users/12345`).then((r) => r.text())
    await new Promise((r) => setTimeout(r, 50))
    server.close()

    expect(steps).toHaveLength(2)
    expect(steps[0]).not.toBeNull()
    expect(steps[0]!.seq).toBe(0)
    expect(steps[1]!.seq).toBe(1)
    expect(steps[0]!.localId).toBe(steps[1]!.localId)

    const { opened, closed } = drainTraces()
    const t = opened.find((x) => x.kind === 'http-server')!
    // normalized, or the trace list becomes one row per user id
    expect(t.name).toBe('GET /api/users/:id')
    expect(closed.find((c) => c.localId === t.localId)!.status).toBe(200)
  })

  it('keeps concurrent requests on one keep-alive agent apart', async () => {
    unpatch = patchServers()
    const perRequest: Record<string, number[]> = {}
    const server = http.createServer(async (req, res) => {
      const which = req.url!.slice(1)
      const a = takeTraceStep()
      await new Promise((r) => setTimeout(r, 10 + Math.round(Number(which) % 3) * 5))
      const b = takeTraceStep()
      perRequest[which] = [a?.localId ?? -1, b?.localId ?? -1]
      res.end('ok')
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    const port = (server.address() as any).port
    const agent = new http.Agent({ keepAlive: true, maxSockets: 3 })
    await Promise.all(Array.from({ length: 30 }, (_, i) =>
      new Promise<void>((resolve) => {
        http.get({ port, path: `/${i}`, agent }, (res) => { res.resume(); res.on('end', () => resolve()) })
      })))
    await new Promise((r) => setTimeout(r, 50))
    agent.destroy()
    server.close()

    const ids = Object.values(perRequest)
    expect(ids).toHaveLength(30)
    // both steps of a request saw the same trace...
    expect(ids.every(([a, b]) => a === b && a > 0)).toBe(true)
    // ...and no two requests shared one
    expect(new Set(ids.map(([a]) => a)).size).toBe(30)
  })

  it('covers HTTP/2, which diagnostics_channel never reports at all', async () => {
    unpatch = patchServers()
    const steps: Array<{ localId: number; seq: number } | null> = []
    const server = http2.createServer((_req, res) => {
      stepInHandler(steps)()
      res.end('ok')
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    const port = (server.address() as any).port
    const client = http2.connect(`http://127.0.0.1:${port}`)
    const st = client.request({ ':path': '/h2/9', ':method': 'GET' })
    st.resume()
    await new Promise((r) => st.on('end', r))
    client.close()
    await new Promise((r) => setTimeout(r, 50))
    server.close()

    expect(steps[0]).not.toBeNull()
    expect(drainTraces().opened.some((t) => t.name === 'GET /h2/:id')).toBe(true)
  })

  it('closes the trace when the client disconnects without the response finishing', async () => {
    unpatch = patchServers()
    let sawRequest = false
    const server = http.createServer((_req, res) => {
      sawRequest = true
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: hi\n\n')   // stream stays open
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    const port = (server.address() as any).port
    const ctl = new AbortController()
    const pending = fetch(`http://127.0.0.1:${port}/stream`, { signal: ctl.signal }).catch(() => {})
    await new Promise((r) => setTimeout(r, 60))
    ctl.abort()
    await pending
    await new Promise((r) => setTimeout(r, 80))
    server.close()

    expect(sawRequest).toBe(true)
    // 'close' fires even though 'finish' never did — without listening for it
    // the trace would sit in the pending map forever
    expect(liveTraceCount()).toBe(0)
    expect(drainTraces().closed.some((t) => t.name === 'GET /stream')).toBe(true)
  })

  it('a stuck stream is force-closed by the sweep rather than leaking', async () => {
    unpatch = patchServers()
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: hi\n\n')
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    const port = (server.address() as any).port
    const ctl = new AbortController()
    void fetch(`http://127.0.0.1:${port}/sse`, { signal: ctl.signal }).catch(() => {})
    await new Promise((r) => setTimeout(r, 60))

    expect(liveTraceCount()).toBe(1)
    sweepStaleTraces(0, Date.now() + 1)
    expect(liveTraceCount()).toBe(0)
    expect(drainTraces().closed.some((t) => t.incomplete)).toBe(true)

    ctl.abort()
    server.close()
  })

  it('never affects the host app when burn0 internals throw', async () => {
    // the guarantee that matters most: a broken burn0 must not break the server
    unpatch = patchServers({ normalizePath: () => { throw new Error('boom') } })
    const server = http.createServer((_req, res) => res.end('app-response'))
    await new Promise<void>((r) => server.listen(0, () => r()))
    const port = (server.address() as any).port
    const body = await fetch(`http://127.0.0.1:${port}/x`).then((r) => r.text())
    server.close()
    expect(body).toBe('app-response')
  })

  it('tolerates being patched twice', () => {
    const first = patchServers()
    const second = patchServers()
    const proto = serverPrototypes()[0].proto
    const doubled = proto.emit
    second()
    first()
    expect(proto.emit).not.toBe(doubled)
  })
})
