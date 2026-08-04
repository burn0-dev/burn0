import { describe, it, expect } from 'vitest'
import { detectEntity, normalizeEndpoint } from '../src/entities/index.js'

describe('detectEntity', () => {
  it('detects LLM providers', () => {
    expect(detectEntity('api.openai.com')).toEqual({ entity: 'OpenAI', entityClass: 'llm', provider: 'openai' })
    expect(detectEntity('api.anthropic.com')).toEqual({ entity: 'Anthropic', entityClass: 'llm', provider: 'anthropic' })
    expect(detectEntity('generativelanguage.googleapis.com')).toEqual({ entity: 'Gemini', entityClass: 'llm', provider: 'gemini' })
  })
  it('detects general services', () => {
    expect(detectEntity('abcd1234.supabase.co')).toEqual({ entity: 'Supabase', entityClass: 'general', provider: null })
    expect(detectEntity('api.stripe.com')).toEqual({ entity: 'Stripe', entityClass: 'general', provider: null })
  })
  it('groups unknown hosts by registrable domain', () => {
    expect(detectEntity('api.foo.com')).toEqual({ entity: 'foo.com', entityClass: 'general', provider: null })
    expect(detectEntity('a.b.example.co.uk')).toEqual({ entity: 'example.co.uk', entityClass: 'general', provider: null })
  })
})

describe('normalizeEndpoint', () => {
  it('replaces numeric ids, uuids, long hex', () => {
    expect(normalizeEndpoint('/users/123/orders/456')).toBe('/users/:id/orders/:id')
    expect(normalizeEndpoint('/v1/items/550e8400-e29b-41d4-a716-446655440000')).toBe('/v1/items/:id')
    expect(normalizeEndpoint('/obj/deadbeefdeadbeefdeadbeef')).toBe('/obj/:id')
  })
  it('keeps normal segments and drops nothing else', () => {
    expect(normalizeEndpoint('/rest/v1/users')).toBe('/rest/v1/users')
    expect(normalizeEndpoint('/v1/chat/completions')).toBe('/v1/chat/completions')
  })
})

describe('detectEntity ip hosts', () => {
  it('keeps IP addresses whole', () => {
    expect(detectEntity('127.0.0.1').entity).toBe('127.0.0.1')
    expect(detectEntity('192.168.1.20').entity).toBe('192.168.1.20')
  })
})
