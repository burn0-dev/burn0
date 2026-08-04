import { describe, it, expect } from 'vitest'
import { parseToolCalls, parseToolResults } from '../src/llm/tools.js'

const openaiDeclares = JSON.stringify({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'search_orders', arguments: '{"customer":"acme"}' } },
        { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } },
      ],
    },
  }],
})

const anthropicDeclares = JSON.stringify({
  content: [
    { type: 'text', text: 'Let me look that up.' },
    { type: 'tool_use', id: 'toolu_1', name: 'search_orders', input: { customer: 'acme' } },
  ],
})

describe('parseToolCalls', () => {
  it('reads OpenAI tool_calls', () => {
    const calls = parseToolCalls(openaiDeclares)
    expect(calls.map((c) => [c.id, c.name])).toEqual([
      ['call_a', 'search_orders'], ['call_b', 'get_weather'],
    ])
    expect(calls[0].args).toBe('{"customer":"acme"}')
  })

  it('reads Anthropic tool_use blocks, which sit beside text', () => {
    const calls = parseToolCalls(anthropicDeclares)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('toolu_1')
    expect(calls[0].name).toBe('search_orders')
    expect(JSON.parse(calls[0].args!)).toEqual({ customer: 'acme' })
  })

  it('assembles tool calls delivered as SSE deltas', () => {
    // arguments arrive as partial JSON string fragments across chunks
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"search_orders","arguments":"{\\"cust"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"omer\\":\\"acme\\"}"}}]}}]}',
      'data: [DONE]',
    ].join('\n\n')
    const calls = parseToolCalls(sse)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('call_x')
    expect(calls[0].name).toBe('search_orders')
    expect(JSON.parse(calls[0].args!)).toEqual({ customer: 'acme' })
  })

  it('returns nothing for an ordinary answer', () => {
    expect(parseToolCalls(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }))).toEqual([])
    expect(parseToolCalls(null)).toEqual([])
    expect(parseToolCalls('not json')).toEqual([])
  })

  it('never throws on a malformed or truncated body', () => {
    expect(() => parseToolCalls('{"choices":[{"message":{"tool_calls":')).not.toThrow()
    expect(parseToolCalls('{"choices":[{"message":{"tool_calls":[{"id":1}]}}]}')).toEqual([])
  })

  describe('Anthropic SSE tool calls', () => {
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
      // arguments split MID-KEY across deltas — the shape that breaks naive parsers
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"opera"}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"tion\\":\\"GET\\",\\"path\\":\\"/A_SalesOrder\\"}"}}',
      '',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'data: {"type":"message_delta","usage":{"output_tokens":9}}',
      '',
    ].join('\n')

    it('accumulates tool_use blocks from content_block_start + input_json_delta', () => {
      const calls = parseToolCalls(sse)
      expect(calls).toEqual([{
        id: 'toolu_01A',
        name: 'sap_execute_sap_operation',
        args: '{"operation":"GET","path":"/A_SalesOrder"}',
      }])
    })

    it('a text-only Anthropic stream declares no tools', () => {
      const textOnly = sse.split('\n').filter((l) => !l.includes('tool_use') && !l.includes('input_json_delta') && !l.includes('content_block_stop')).join('\n')
      expect(parseToolCalls(textOnly)).toEqual([])
    })

    it('empty-input tool call yields args null', () => {
      const noArgs = [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_02B","name":"sap_list_entities","input":{}}}',
        'data: {"type":"content_block_stop","index":0}',
      ].join('\n')
      expect(parseToolCalls(noArgs)).toEqual([{ id: 'toolu_02B', name: 'sap_list_entities', args: null }])
    })
  })
})

describe('parseToolResults', () => {
  it('reads OpenAI role:tool messages from the follow-up request', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: 'where is my order' },
        { role: 'assistant', tool_calls: [{ id: 'call_a' }] },
        { role: 'tool', tool_call_id: 'call_a', content: '{"status":"shipped"}' },
      ],
    })
    const results = parseToolResults(body)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('call_a')
    expect(results[0].result).toBe('{"status":"shipped"}')
    expect(results[0].isError).toBe(false)
  })

  it('reads Anthropic tool_result blocks and their error flag', () => {
    const body = JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'shipped' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
        ],
      }],
    })
    const results = parseToolResults(body)
    expect(results.map((r) => [r.id, r.isError])).toEqual([['toolu_1', false], ['toolu_2', true]])
  })

  it('treats an OpenAI tool message whose content reads as an error as one', () => {
    // agents fail quietly: the model apologises in prose and the trace looks fine
    const body = JSON.stringify({
      messages: [{ role: 'tool', tool_call_id: 'call_a', content: '{"error":"order not found"}' }],
    })
    expect(parseToolResults(body)[0].isError).toBe(true)
  })

  it('returns nothing for a request that carries no results', () => {
    expect(parseToolResults(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }))).toEqual([])
    expect(parseToolResults(null)).toEqual([])
  })
})
