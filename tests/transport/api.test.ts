import { describe, it, expect, vi } from 'vitest'
import { shipEvents } from '../../src/transport/api'
import type { Burn0Event } from '../../src/types'

function makeEvent(overrides: Partial<Burn0Event> = {}): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    status_code: 200,
    timestamp: new Date().toISOString(),
    duration_ms: 100,
    estimated: false,
    ...overrides,
  }
}

describe('shipEvents', () => {
  it('sends events as JSON POST via fetchFn', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const events = [makeEvent(), makeEvent({ service: 'anthropic' })]

    await shipEvents(events, 'test-key', 'https://api.burn0.dev', mockFetch)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.burn0.dev/v1/events')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key',
    })

    const body = JSON.parse(init.body as string)
    expect(body.events).toHaveLength(2)
    expect(body.events[0].service).toBe('openai')
    expect(body.events[1].service).toBe('anthropic')
  })

  it('includes X-Burn0-SDK-Version header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await shipEvents([makeEvent()], 'key', 'https://api.burn0.dev', mockFetch)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-Burn0-SDK-Version']).toBeDefined()
  })

  it('includes sdk_version in request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await shipEvents([makeEvent()], 'key', 'https://api.burn0.dev', mockFetch)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.sdk_version).toBeDefined()
    expect(typeof body.sdk_version).toBe('string')
  })

  it('returns true on successful response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await shipEvents([makeEvent()], 'key', 'https://api.burn0.dev', mockFetch)
    expect(result).toBe(true)
  })

  it('returns false on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const result = await shipEvents([makeEvent()], 'bad-key', 'https://api.burn0.dev', mockFetch)
    expect(result).toBe(false)
  })

  it('returns false when fetch throws', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const result = await shipEvents([makeEvent()], 'key', 'https://api.burn0.dev', mockFetch)
    expect(result).toBe(false)
  })

  it('sends empty events array without error', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await shipEvents([], 'key', 'https://api.burn0.dev', mockFetch)
    expect(result).toBe(true)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.events).toEqual([])
  })
})
