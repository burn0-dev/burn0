import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { patchFetch, unpatchFetch } from '../../src/interceptor/fetch'
import type { Burn0Event } from '../../src/types'

function makeResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  })
}

describe('patchFetch', () => {
  let events: Burn0Event[]
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    events = []
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    unpatchFetch()
    globalThis.fetch = originalFetch
  })

  it('intercepts fetch and emits event with correct service/endpoint/status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ id: 'chatcmpl-1' }))
    patchFetch((e) => events.push(e))

    const res = await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o' }),
    })

    expect(res).toBeDefined()
    expect(events).toHaveLength(1)
    expect(events[0].service).toBe('openai')
    expect(events[0].endpoint).toBe('/v1/chat/completions')
    expect(events[0].status_code).toBe(200)
  })

  it('ignores localhost requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse({}))
    globalThis.fetch = mockFetch
    patchFetch((e) => events.push(e))

    await globalThis.fetch('http://localhost:3000/api/test')

    expect(events).toHaveLength(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('ignores 127.0.0.1 requests', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({}))
    patchFetch((e) => events.push(e))

    await globalThis.fetch('http://127.0.0.1:8080/health')

    expect(events).toHaveLength(0)
  })

  it('does not break the response for the caller', async () => {
    const body = { id: 'msg-1', model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 10, output_tokens: 20 } }
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(body))
    patchFetch((e) => events.push(e))

    const res = await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('msg-1')
  })

  it('extracts model from request body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({}))
    patchFetch((e) => events.push(e))

    await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o-mini' }),
    })

    expect(events[0].model).toBe('gpt-4o-mini')
  })

  it('extracts model and usage from response body', async () => {
    const body = {
      model: 'gpt-4o',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(body))
    patchFetch((e) => events.push(e))

    await globalThis.fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(events[0].model).toBe('gpt-4o')
    expect(events[0].tokens_in).toBe(100)
    expect(events[0].tokens_out).toBe(50)
  })

  it('extracts anthropic-style usage tokens (input_tokens/output_tokens)', async () => {
    const body = {
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 200, output_tokens: 75 },
    }
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(body))
    patchFetch((e) => events.push(e))

    await globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })

    expect(events[0].tokens_in).toBe(200)
    expect(events[0].tokens_out).toBe(75)
  })

  it('emits event for unknown external services', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({}, 201))
    patchFetch((e) => events.push(e))

    await globalThis.fetch('https://some-external-api.io/v2/data')

    expect(events).toHaveLength(1)
    expect(events[0].service).toBe('unknown:some-external-api.io')
    expect(events[0].status_code).toBe(201)
  })

  it('unpatchFetch restores original fetch', async () => {
    const originalImpl = vi.fn().mockResolvedValue(makeResponse({}))
    globalThis.fetch = originalImpl
    patchFetch((e) => events.push(e))

    // Patched fetch should be different
    const patchedFetch = globalThis.fetch
    unpatchFetch()

    // After unpatching, should be original again
    expect(globalThis.fetch).toBe(originalImpl)
    expect(globalThis.fetch).not.toBe(patchedFetch)
  })

  it('unpatchFetch is idempotent (calling twice does not throw)', () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({}))
    patchFetch((e) => events.push(e))
    unpatchFetch()
    expect(() => unpatchFetch()).not.toThrow()
  })

  it('includes schema_version, timestamp, duration_ms, estimated in event', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({}))
    patchFetch((e) => events.push(e))

    await globalThis.fetch('https://api.openai.com/v1/chat/completions')

    const event = events[0]
    expect(event.schema_version).toBe(1)
    expect(typeof event.timestamp).toBe('string')
    expect(event.duration_ms).toBeGreaterThanOrEqual(0)
    expect(event.estimated).toBe(false)
  })

  it('does not propagate errors thrown by onEvent callback', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({}))
    patchFetch(() => { throw new Error('callback error') })

    await expect(globalThis.fetch('https://api.openai.com/v1/test')).resolves.toBeDefined()
  })
})
