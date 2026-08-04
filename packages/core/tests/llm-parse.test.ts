import { describe, it, expect } from 'vitest'
import { extractModel, parseUsage, parseSSEUsage } from '../src/llm/parse.js'

describe('extractModel', () => {
  it('reads model from request body', () => {
    expect(extractModel('{"model":"gpt-4o","messages":[]}', '/v1/chat/completions', null)).toBe('gpt-4o')
  })
  it('reads Gemini-style model from URL path', () => {
    expect(extractModel(null, '/v1beta/models/gemini-2.0-flash:generateContent', null)).toBe('gemini-2.0-flash')
  })
  it('falls back to response body model', () => {
    expect(extractModel(null, '/v1/messages', '{"model":"claude-sonnet-4-5","usage":{}}')).toBe('claude-sonnet-4-5')
  })
})

describe('parseUsage', () => {
  it('parses OpenAI usage with cached tokens', () => {
    expect(parseUsage('{"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}'))
      .toEqual({ tokensIn: 100, tokensOut: 20, tokensCached: 80 })
  })
  it('parses Anthropic usage', () => {
    expect(parseUsage('{"usage":{"input_tokens":50,"output_tokens":10,"cache_read_input_tokens":30}}'))
      .toEqual({ tokensIn: 50, tokensOut: 10, tokensCached: 30 })
  })
  it('parses Gemini usageMetadata', () => {
    expect(parseUsage('{"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":8,"cachedContentTokenCount":16}}'))
      .toEqual({ tokensIn: 40, tokensOut: 8, tokensCached: 16 })
  })
  it('returns null for non-LLM json and garbage', () => {
    expect(parseUsage('{"ok":true}')).toBeNull()
    expect(parseUsage('not json')).toBeNull()
    expect(parseUsage(null)).toBeNull()
  })
})

describe('parseSSEUsage', () => {
  it('reads OpenAI final-chunk usage', () => {
    const raw = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
    expect(parseSSEUsage(raw)).toEqual({ tokensIn: 9, tokensOut: 3, tokensCached: null })
  })
  it('combines Anthropic message_start input and message_delta output', () => {
    const raw = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":5}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":12}}',
      '',
    ].join('\n')
    expect(parseSSEUsage(raw)).toEqual({ tokensIn: 25, tokensOut: 12, tokensCached: 5 })
  })
  it('returns null when stream has no usage', () => {
    expect(parseSSEUsage('data: {"choices":[]}\n\ndata: [DONE]\n\n')).toBeNull()
  })
})
