import { describe, it, expect } from 'vitest'
import { extractExchange, extractPrompt, extractAnswer, extractTranscript } from '../src/tui/llm-io.js'

describe('extractExchange — request side', () => {
  it('OpenAI JSON chat: system + last user text, message counts', () => {
    const req = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'What is CAP?' },
      ],
    })
    const res = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '42.' } }] })
    const ex = extractExchange(req, res)
    expect(ex.parsed).toBe(true)
    expect(ex.systemFirstLine).toBe('be brief')
    expect(ex.systemChars).toBe('be brief'.length)
    expect(ex.lastUserText).toBe('What is CAP?')
    expect(ex.assistantText).toBe('42.')
    expect(ex.toolCalls).toEqual([])
    expect(ex.msgCount).toBe(2)
    // both messages are rendered (system + last user) -> nothing earlier
    expect(ex.earlierCount).toBe(0)
  })

  it('Anthropic JSON: top-level system does not consume a messages[] slot', () => {
    const req = JSON.stringify({
      system: 'You are terse.',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'Explain DNS' }] },
      ],
    })
    const ex = extractExchange(req, null)
    expect(ex.systemFirstLine).toBe('You are terse.')
    expect(ex.lastUserText).toBe('Explain DNS')
    expect(ex.msgCount).toBe(3)
    // rendered: last user only (system is top-level, doesn't occupy a slot;
    // the earlier user+assistant turn is "earlier")
    expect(ex.earlierCount).toBe(2)
  })

  it('embeddings body: input -> lastUserText', () => {
    const ex = extractExchange(JSON.stringify({ model: 'text-embedding-3-small', input: 'a piece of text' }), null)
    expect(ex.lastUserText).toBe('a piece of text')
    expect(ex.parsed).toBe(true)
  })

  it('unparseable body: parsed false, everything defaulted', () => {
    const ex = extractExchange('not json', 'also not json')
    expect(ex.parsed).toBe(false)
    expect(ex.msgCount).toBe(0)
    expect(ex.earlierCount).toBe(0)
    expect(ex.lastUserText).toBeNull()
    expect(ex.systemFirstLine).toBeNull()
    expect(ex.systemChars).toBe(0)
    expect(ex.assistantText).toBeNull()
    expect(ex.toolCalls).toEqual([])
    expect(ex.toolResults).toEqual([])
  })

  it('null bodies are not a parse failure', () => {
    const ex = extractExchange(null, null)
    expect(ex.parsed).toBe(true)
    expect(ex.lastUserText).toBeNull()
    expect(ex.assistantText).toBeNull()
  })

  it('tool_result blocks: name resolved via the declaring assistant message, unmatched -> null', () => {
    const req = JSON.stringify({
      messages: [
        { role: 'user', content: 'where is my order' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'toolu_1', name: 'search_orders', input: { id: 42 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'shipped' },
            { type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'boom', is_error: true },
          ],
        },
      ],
    })
    const ex = extractExchange(req, null)
    expect(ex.toolResults).toEqual([
      { name: 'search_orders', isError: false, bytes: Buffer.byteLength('shipped') },
      { name: null, isError: true, bytes: Buffer.byteLength('boom') },
    ])
    // rendered: last user text falls back to "where is my order" (the
    // tool_result-only message has no real text so it's skipped) + the
    // tool-result message itself
    expect(ex.lastUserText).toBe('where is my order')
    expect(ex.msgCount).toBe(3)
    expect(ex.earlierCount).toBe(1) // the assistant turn that declared the call
  })

  it('OpenAI role:tool results also resolve by id against the assistant message', () => {
    const req = JSON.stringify({
      messages: [
        { role: 'user', content: 'where is my order' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'search_orders', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_a', content: '{"status":"shipped"}' },
      ],
    })
    const ex = extractExchange(req, null)
    expect(ex.toolResults).toEqual([
      { name: 'search_orders', isError: false, bytes: Buffer.byteLength('{"status":"shipped"}') },
    ])
  })
})

describe('extractExchange — response side', () => {
  it('Anthropic JSON tool_use-only response: toolCalls non-empty, assistantText null (the §8.1 fix)', () => {
    const res = JSON.stringify({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_orders', input: { customer: 'acme' } }],
    })
    const ex = extractExchange(null, res)
    expect(ex.assistantText).toBeNull()
    expect(ex.toolCalls).toEqual([{ name: 'search_orders', args: JSON.stringify({ customer: 'acme' }) }])
  })

  it('OpenAI JSON tool_calls-only response: same fix', () => {
    const res = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } },
      ] } }],
    })
    const ex = extractExchange(null, res)
    expect(ex.assistantText).toBeNull()
    expect(ex.toolCalls).toEqual([{ name: 'get_weather', args: '{"city":"Berlin"}' }])
  })

  it('Anthropic SSE: text deltas and tool deltas both extracted, raw data: lines never surfaced', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01A","name":"sap_execute_sap_operation","input":{}}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"opera"}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"tion\\":\\"GET\\"}"}}',
      '',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'data: {"type":"message_delta","usage":{"output_tokens":9}}',
      '',
    ].join('\n')
    const ex = extractExchange(null, sse)
    expect(ex.assistantText).toBe('Let me check.')
    expect(ex.toolCalls).toEqual([{ name: 'sap_execute_sap_operation', args: '{"operation":"GET"}' }])
    for (const field of [ex.assistantText, ...ex.toolCalls.map((c) => c.args)]) {
      expect(field).not.toContain('data:')
      expect(field).not.toContain('content_block_delta')
    }
  })

  it('OpenAI SSE text deltas', () => {
    const raw = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n'
    expect(extractExchange(null, raw).assistantText).toBe('Hello')
  })

  it('Gemini candidates (best-effort, unaffected by the tool-call fix)', () => {
    expect(extractExchange(null, JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Answer.' }] } }] })).assistantText)
      .toBe('Answer.')
  })

  it('unparseable response body', () => {
    const ex = extractExchange(null, 'not json and not sse')
    expect(ex.parsed).toBe(false)
    expect(ex.assistantText).toBeNull()
    expect(ex.toolCalls).toEqual([])
  })
})

describe('extractPrompt / extractAnswer (thin wrappers)', () => {
  it('extractPrompt delegates to lastUserText', () => {
    expect(extractPrompt('{"messages":[{"role":"user","content":"What is CAP?"}]}')).toBe('What is CAP?')
    expect(extractPrompt(null)).toBeNull()
  })

  it('extractAnswer returns assistant text when present', () => {
    expect(extractAnswer(JSON.stringify({ choices: [{ message: { content: '42.' } }] }))).toBe('42.')
  })

  it('extractAnswer renders tool calls instead of coming back empty (§8.1 fix)', () => {
    const res = JSON.stringify({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_orders', input: { customer: 'acme' } }],
    })
    expect(extractAnswer(res)).toBe(`→ search_orders(${JSON.stringify({ customer: 'acme' })})`)
  })

  it('extractAnswer is null when there is neither text nor tool calls', () => {
    expect(extractAnswer(JSON.stringify({ ok: true }))).toBeNull()
    expect(extractAnswer(null)).toBeNull()
  })
})

describe('extractTranscript — every message, in order (task 15, Debug screen full view)', () => {
  it('OpenAI: system, user, then the response turn appended last', () => {
    const req = JSON.stringify({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'What is CAP?' },
      ],
    })
    const res = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '42.' } }] })
    expect(extractTranscript(req, res)).toEqual([
      { role: 'system', text: `be brief  (${'be brief'.length} chars)` },
      { role: 'user', text: 'What is CAP?' },
      { role: 'assistant', text: '42.', toolCalls: undefined },
    ])
  })

  it('Anthropic: top-level system shown once, full multi-turn history preserved in order', () => {
    const req = JSON.stringify({
      system: 'You are terse.',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'Explain DNS' }] },
      ],
    })
    expect(extractTranscript(req, null)).toEqual([
      { role: 'system', text: `You are terse.  (${'You are terse.'.length} chars)` },
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello', toolCalls: undefined },
      { role: 'user', text: 'Explain DNS' },
    ])
  })

  it('system first line only, chars note counts the full text', () => {
    const req = JSON.stringify({
      messages: [
        { role: 'system', content: 'line one\nline two\nline three' },
        { role: 'user', content: 'hi' },
      ],
    })
    const [system] = extractTranscript(req, null)
    expect(system).toEqual({ role: 'system', text: `line one  (${'line one\nline two\nline three'.length} chars)` })
  })

  it('tool_result blocks (Anthropic) become tool entries with ✓/✗-ready fields, resolved by name', () => {
    const req = JSON.stringify({
      messages: [
        { role: 'user', content: 'where is my order' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'toolu_1', name: 'search_orders', input: { id: 42 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'shipped' },
            { type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'boom', is_error: true },
          ],
        },
      ],
    })
    expect(extractTranscript(req, null)).toEqual([
      { role: 'user', text: 'where is my order' },
      {
        role: 'assistant', text: 'let me check',
        toolCalls: [{ name: 'search_orders', args: JSON.stringify({ id: 42 }) }],
      },
      { role: 'tool', text: null, toolResult: { name: 'search_orders', isError: false, bytes: Buffer.byteLength('shipped') } },
      { role: 'tool', text: null, toolResult: { name: null, isError: true, bytes: Buffer.byteLength('boom') } },
    ])
  })

  it('OpenAI role:tool results become tool entries, name resolved via the declaring assistant message', () => {
    const req = JSON.stringify({
      messages: [
        { role: 'user', content: 'where is my order' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'search_orders', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_a', content: '{"status":"shipped"}' },
      ],
    })
    expect(extractTranscript(req, null)).toEqual([
      { role: 'user', text: 'where is my order' },
      { role: 'assistant', text: null, toolCalls: [{ name: 'search_orders', args: '{}' }] },
      { role: 'tool', text: null, toolResult: { name: 'search_orders', isError: false, bytes: Buffer.byteLength('{"status":"shipped"}') } },
    ])
  })

  it('tool-call-only response turn is never empty (§8.1 fix, surfaced through the transcript too)', () => {
    const res = JSON.stringify({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_orders', input: { customer: 'acme' } }],
    })
    const t = extractTranscript(null, res)
    expect(t).toEqual([
      { role: 'assistant', text: null, toolCalls: [{ name: 'search_orders', args: JSON.stringify({ customer: 'acme' }) }] },
    ])
  })

  it('embeddings body: single user entry from `input`', () => {
    expect(extractTranscript(JSON.stringify({ input: 'a piece of text' }), null)).toEqual([
      { role: 'user', text: 'a piece of text' },
    ])
  })

  it('unparseable request, parseable response: only the response turn survives', () => {
    const res = JSON.stringify({ choices: [{ message: { content: 'hi' } }] })
    expect(extractTranscript('not json', res)).toEqual([{ role: 'assistant', text: 'hi', toolCalls: undefined }])
  })

  it('null bodies: empty transcript', () => {
    expect(extractTranscript(null, null)).toEqual([])
  })

  it('a request-side assistant message with neither text nor tool calls is dropped, not rendered empty', () => {
    const req = JSON.stringify({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null },
      ],
    })
    expect(extractTranscript(req, null)).toEqual([{ role: 'user', text: 'hi' }])
  })
})
