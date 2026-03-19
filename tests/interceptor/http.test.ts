import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { patchHttp, unpatchHttp } from '../../src/interceptor/http'
import type { Burn0Event } from '../../src/types'

// Helper to create a fake ClientRequest + IncomingMessage pair
function makeFakeRequest(opts: {
  statusCode?: number
  contentType?: string
  body?: string
} = {}): { req: http.ClientRequest; triggerResponse: () => void } {
  const req = new EventEmitter() as http.ClientRequest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(req as any).end = vi.fn()

  const triggerResponse = () => {
    const res = new EventEmitter() as http.IncomingMessage
    res.headers = { 'content-type': opts.contentType ?? 'application/json' }
    res.statusCode = opts.statusCode ?? 200

    req.emit('response', res)

    if (opts.body) {
      res.emit('data', Buffer.from(opts.body))
    }
    res.emit('end')
  }

  return { req, triggerResponse }
}

describe('patchHttp', () => {
  let events: Burn0Event[]
  let originalHttpRequest: typeof http.request
  let originalHttpsRequest: typeof https.request
  let originalHttpGet: typeof http.get
  let originalHttpsGet: typeof https.get

  beforeEach(() => {
    events = []
    originalHttpRequest = http.request
    originalHttpsRequest = https.request
    originalHttpGet = http.get
    originalHttpsGet = https.get
  })

  afterEach(() => {
    unpatchHttp()
    // Restore in case mock was set directly
    http.request = originalHttpRequest
    https.request = originalHttpsRequest
    http.get = originalHttpGet
    https.get = originalHttpsGet
  })

  it('does not track 127.0.0.1 requests', () => {
    const { req, triggerResponse } = makeFakeRequest()
    const mockRequest = vi.fn().mockReturnValue(req)
    http.request = mockRequest as unknown as typeof http.request
    patchHttp((e) => events.push(e))

    const result = http.request({ hostname: '127.0.0.1', path: '/health' })
    triggerResponse()

    expect(events).toHaveLength(0)
    expect(result).toBe(req)
  })

  it('does not track localhost requests', () => {
    const { req, triggerResponse } = makeFakeRequest()
    const mockRequest = vi.fn().mockReturnValue(req)
    http.request = mockRequest as unknown as typeof http.request
    patchHttp((e) => events.push(e))

    http.request({ hostname: 'localhost', path: '/api' })
    triggerResponse()

    expect(events).toHaveLength(0)
  })

  it('tracks requests to known external services', () => {
    const body = JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 50, completion_tokens: 25 } })
    const { req, triggerResponse } = makeFakeRequest({ body, statusCode: 200 })
    const mockRequest = vi.fn().mockReturnValue(req)
    https.request = mockRequest as unknown as typeof https.request
    patchHttp((e) => events.push(e))

    https.request({ hostname: 'api.openai.com', path: '/v1/chat/completions' })
    triggerResponse()

    expect(events).toHaveLength(1)
    expect(events[0].service).toBe('openai')
    expect(events[0].endpoint).toBe('/v1/chat/completions')
    expect(events[0].model).toBe('gpt-4o')
    expect(events[0].tokens_in).toBe(50)
    expect(events[0].tokens_out).toBe(25)
    expect(events[0].status_code).toBe(200)
  })

  it('tracks unknown external hosts', () => {
    const { req, triggerResponse } = makeFakeRequest({ statusCode: 201 })
    const mockRequest = vi.fn().mockReturnValue(req)
    https.request = mockRequest as unknown as typeof https.request
    patchHttp((e) => events.push(e))

    https.request({ hostname: 'custom-api.example.com', path: '/data' })
    triggerResponse()

    expect(events).toHaveLength(1)
    expect(events[0].service).toBe('unknown:custom-api.example.com')
    expect(events[0].status_code).toBe(201)
  })

  it('does not buffer non-JSON responses', () => {
    const { req, triggerResponse } = makeFakeRequest({
      contentType: 'text/html',
      body: '<html>ok</html>',
      statusCode: 200,
    })
    const mockRequest = vi.fn().mockReturnValue(req)
    https.request = mockRequest as unknown as typeof https.request
    patchHttp((e) => events.push(e))

    https.request({ hostname: 'api.openai.com', path: '/v1/models' })
    triggerResponse()

    expect(events).toHaveLength(1)
    expect(events[0].model).toBeUndefined()
    expect(events[0].tokens_in).toBeUndefined()
  })

  it('unpatchHttp restores original http.request', () => {
    const original = http.request
    patchHttp((e) => events.push(e))
    expect(http.request).not.toBe(original)
    unpatchHttp()
    expect(http.request).toBe(original)
  })

  it('unpatchHttp restores original https.request', () => {
    const original = https.request
    patchHttp((e) => events.push(e))
    expect(https.request).not.toBe(original)
    unpatchHttp()
    expect(https.request).toBe(original)
  })

  it('unpatchHttp restores http.get and https.get', () => {
    const origGet = http.get
    const origHttpsGet = https.get
    patchHttp((e) => events.push(e))
    unpatchHttp()
    expect(http.get).toBe(origGet)
    expect(https.get).toBe(origHttpsGet)
  })

  it('includes schema_version, timestamp, duration_ms, estimated in event', () => {
    const { req, triggerResponse } = makeFakeRequest({ statusCode: 200 })
    const mockRequest = vi.fn().mockReturnValue(req)
    https.request = mockRequest as unknown as typeof https.request
    patchHttp((e) => events.push(e))

    https.request({ hostname: 'api.anthropic.com', path: '/v1/messages' })
    triggerResponse()

    const event = events[0]
    expect(event.schema_version).toBe(1)
    expect(typeof event.timestamp).toBe('string')
    expect(event.duration_ms).toBeGreaterThanOrEqual(0)
    expect(event.estimated).toBe(false)
  })
})
