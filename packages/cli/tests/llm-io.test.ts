import { describe, it, expect } from 'vitest'
import { extractPrompt, extractAnswer } from '../src/tui/llm-io.js'

describe('extractPrompt', () => {
  it('openai/anthropic messages', () => {
    expect(extractPrompt('{"model":"gpt-4o","messages":[{"role":"system","content":"be brief"},{"role":"user","content":"What is CAP?"}]}'))
      .toBe('What is CAP?')
  })
  it('anthropic content parts array', () => {
    expect(extractPrompt('{"messages":[{"role":"user","content":[{"type":"text","text":"Hello there"}]}]}'))
      .toBe('Hello there')
  })
  it('gemini contents', () => {
    expect(extractPrompt('{"contents":[{"role":"user","parts":[{"text":"Explain DNS"}]}]}')).toBe('Explain DNS')
  })
  it('null for unknown/garbage', () => {
    expect(extractPrompt('{"foo":1}')).toBeNull()
    expect(extractPrompt('nope')).toBeNull()
    expect(extractPrompt(null)).toBeNull()
  })
})

describe('extractAnswer', () => {
  it('openai choices', () => {
    expect(extractAnswer('{"choices":[{"message":{"role":"assistant","content":"42."}}]}')).toBe('42.')
  })
  it('anthropic content blocks', () => {
    expect(extractAnswer('{"content":[{"type":"text","text":"Sure, "},{"type":"text","text":"here."}]}')).toBe('Sure, here.')
  })
  it('gemini candidates', () => {
    expect(extractAnswer('{"candidates":[{"content":{"parts":[{"text":"Answer."}]}}]}')).toBe('Answer.')
  })
  it('openai SSE stream deltas', () => {
    const raw = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n'
    expect(extractAnswer(raw)).toBe('Hello')
  })
  it('anthropic SSE content_block_delta', () => {
    const raw = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi "}}\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"you"}}\n'
    expect(extractAnswer(raw)).toBe('Hi you')
  })
  it('null for unknown', () => {
    expect(extractAnswer('{"ok":true}')).toBeNull()
    expect(extractAnswer(null)).toBeNull()
  })
})
