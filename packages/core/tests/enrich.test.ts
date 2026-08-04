import { describe, it, expect } from 'vitest'
import { enrich } from '../src/capture/enrich.js'
import type { CaptureEvent } from '../src/types.js'

const base: CaptureEvent = {
  startedAt: 1, method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
  hostname: 'api.openai.com', status: 200, firstByteMs: 10, latencyMs: 100,
  reqBytes: 10, resBytes: 20,
  reqHeaders: { authorization: 'Bearer sk-secret123456789' },
  resHeaders: { 'content-type': 'application/json' },
  reqBody: '{"model":"gpt-4o","messages":[]}',
  resBody: '{"usage":{"prompt_tokens":1000,"completion_tokens":100}}',
  stackSnippet: null, tags: null, estimated: false,
}
const pricing = { 'gpt-4o': { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 } }
const opts = { pricing, bodyCapBytes: 1048576, redactDisabled: false, extraRedactHeaders: [], isSSE: false }

describe('enrich', () => {
  it('produces a fully enriched LLM row with cost and redaction', () => {
    const row = enrich(base, opts)
    expect(row.entity).toBe('OpenAI')
    expect(row.provider).toBe('openai')
    expect(row.model).toBe('gpt-4o')
    expect(row.tokensIn).toBe(1000)
    expect(row.costUsd).toBeCloseTo(0.003, 10)
    expect(row.reqHeaders.authorization).toBe('[redacted]')
    expect(row.normalizedEndpoint).toBe('/v1/chat/completions')
  })
  it('parses SSE bodies when isSSE', () => {
    const row = enrich({ ...base, resBody: 'data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n' }, { ...opts, isSSE: true })
    expect(row.tokensIn).toBe(5)
    expect(row.tokensOut).toBe(2)
  })
  it('truncates oversized bodies and flags them', () => {
    const row = enrich({ ...base, resBody: 'x'.repeat(2000) }, { ...opts, bodyCapBytes: 1000 })
    expect(row.resBody!.length).toBe(1000)
    expect(row.resTruncated).toBe(true)
    expect(row.reqTruncated).toBe(false)
  })
  it('general entity: no provider, no cost', () => {
    const row = enrich({ ...base, url: 'https://api.stripe.com/v1/charges/ch_123', hostname: 'api.stripe.com', reqBody: null, resBody: '{"id":"ch_123"}' }, opts)
    expect(row.entityClass).toBe('general')
    expect(row.provider).toBeNull()
    expect(row.costUsd).toBeNull()
    expect(row.normalizedEndpoint).toBe('/v1/charges/ch_123') // ch_123 not numeric/uuid/hex16 — kept
  })
  it('unknown model on LLM host: row kept, cost null', () => {
    const row = enrich({ ...base, reqBody: '{"model":"brand-new-model"}' , resBody: '{"usage":{"prompt_tokens":1,"completion_tokens":1}}' }, opts)
    expect(row.model).toBe('brand-new-model')
    expect(row.costUsd).toBeNull()
  })
  it('normalizes Anthropic input to total-effective and stores cache write (spec §1.2)', () => {
    const row = enrich({
      ...base,
      hostname: 'api.anthropic.com',
      resBody: JSON.stringify({ model: 'claude-sonnet-5', usage: {
        input_tokens: 2, output_tokens: 846,
        cache_read_input_tokens: 46800, cache_creation_input_tokens: 1024 } }),
    }, opts)
    expect(row.tokensIn).toBe(47826)         // 2 + 46800 + 1024 — never again "2 → 846"
    expect(row.tokensCached).toBe(46800)
    expect(row.tokensCacheWrite).toBe(1024)
  })
})
