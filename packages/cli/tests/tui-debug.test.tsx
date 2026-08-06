import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { DebugScreen } from '../src/tui/screens/Debug.js'
import { seedDb } from './helpers/seed.js'
import { query } from '@burn0/core'

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))
const RIGHT = '\u001B[C'
const V = { columns: 100, rows: 30 }

describe('DebugScreen', () => {
  it('prompts when nothing selected', () => {
    const { db } = seedDb([])
    expect(render(<DebugScreen db={db} requestId={null} />).lastFrame()).toContain('Select a request')
  })
  it('Summary/Metadata/Raw split the detail: waterfall and tags up front, stack and bodies behind tabs', async () => {
    const { db } = seedDb([{ tags: { userId: 'u9' }, resTruncated: true }])
    const id = query.traces(db, { llm: true })[0].id
    const { lastFrame, stdin } = render(<DebugScreen db={db} requestId={id} viewport={V} />)
    await tick()
    const summary = lastFrame()!
    expect(summary).toContain('POST')
    expect(summary).toContain('api.openai.com')
    expect(summary).toContain('first byte')
    expect(summary).toContain('u9')
    // Raw bodies never render on the default surface.
    expect(summary).not.toContain('"model": "gpt-4o"')

    stdin.write(RIGHT); await tick()   // Input
    stdin.write(RIGHT); await tick()   // Output
    stdin.write(RIGHT); await tick()   // Metadata
    expect(lastFrame()).toContain('server.js:10')

    stdin.write(RIGHT); await tick()   // Raw
    const raw = lastFrame()!
    expect(raw).toContain('"model": "gpt-4o"')   // pretty-printed, bounded
    expect(raw).toContain('truncated at 1MB')
  })
})

describe('DebugScreen — missing payload wording (spec §3/§4)', () => {
  const DAY = 86_400_000
  const RETENTION = { payloads: 7, metadata: 30 }

  it('a young row with no payload says capture was off — never that data expired', () => {
    // capturePayloads: false, seconds ago. Claiming a 7-day expiry here is a
    // false data-loss report about a row that lost nothing.
    const { db } = seedDb([{ startedAt: Date.now() - 10_000 }], { capturePayloads: false })
    const id = query.traces(db, { llm: true })[0].id
    const f = render(
      <DebugScreen db={db} requestId={id} retention={RETENTION} now={Date.now()} />).lastFrame()!
    expect(f).toContain('payloads not captured (capturePayloads: false)')
    expect(f).toContain('stats only')
    expect(f).not.toContain('expired')
    expect(f).not.toContain('7-day retention')
  })

  it('an old LLM row says the conversation expired, with the reader\'s own retention', () => {
    const now = Date.now()
    const { db } = seedDb([{ startedAt: now - 9 * DAY }], { capturePayloads: false })
    const id = query.traces(db, { llm: true })[0].id
    const f = render(
      <DebugScreen db={db} requestId={id} retention={RETENTION} now={now} />).lastFrame()!
    expect(f).toContain('conversation expired (payload retention: 7 days)')
    expect(f).toContain('structure and status remain for 30 days')
  })

  it('an old non-LLM row names what it lost: the request and the response', () => {
    const now = Date.now()
    const { db } = seedDb([{
      startedAt: now - 9 * DAY, model: null, entityClass: 'general', provider: null,
      hostname: 'api.pinecone.io', entity: 'Pinecone', normalizedEndpoint: '/query',
      url: 'https://api.pinecone.io/query', tokensIn: null, tokensOut: null, costUsd: null,
    }], { capturePayloads: false })
    const id = query.traces(db, {})[0].id
    const f = render(
      <DebugScreen db={db} requestId={id} retention={RETENTION} now={now} />).lastFrame()!
    expect(f).toContain('request & response expired (payload retention: 7 days)')
  })

  it('never renders the hardcoded 7-day claim', () => {
    const { db } = seedDb([{ startedAt: Date.now() }])
    const id = query.traces(db, { llm: true })[0].id
    const f = render(<DebugScreen db={db} requestId={id} />).lastFrame()!
    expect(f).not.toContain('Payload expired (7-day retention) — metadata only.')
  })
})

describe('DebugScreen — URL redaction (spec §6)', () => {
  it('redacts query-string secrets rather than printing them', () => {
    const { db } = seedDb([{
      url: 'https://api.openai.com/v1/x?api_key=9f2c8ab71d&token=sk-live-AAAABBBBCCCCDDDD&model=gpt-4o',
    }])
    const id = query.traces(db, { llm: true })[0].id
    const f = render(<DebugScreen db={db} requestId={id} />).lastFrame()!
    expect(f).toContain('[redacted]')
    expect(f).not.toContain('9f2c8ab71d')
    expect(f).not.toContain('sk-live-AAAABBBBCCCCDDDD')
    // the non-secret parameter survives — redaction, not deletion
    expect(f).toContain('model=gpt-4o')
  })
})

describe('DebugScreen LLM conversation section (task 15: chat-style, full transcript)', () => {
  it('shows the full conversation in order — system, user, assistant', async () => {
    const { db } = seedDb([{
      model: 'gpt-4o', tokensIn: 120, tokensOut: 40, costUsd: 0.004,
      reqBody: JSON.stringify({ model: 'gpt-4o', messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'What is the CAP theorem?' },
      ] }),
      resBody: JSON.stringify({ model: 'gpt-4o', choices: [
        { message: { role: 'assistant', content: 'Pick two of consistency, availability, partition tolerance.' } },
      ], usage: { prompt_tokens: 120, completion_tokens: 40 } }),
    }])
    const id = query.traces(db, { llm: true })[0].id
    const { lastFrame, stdin } = render(<DebugScreen db={db} requestId={id} viewport={V} />)
    await tick()
    // Summary: the human exchange and token head are immediately visible.
    const summary = lastFrame()!
    expect(summary).toContain('USER')
    expect(summary).toContain('What is the CAP theorem?')
    expect(summary).toContain('ASSISTANT')
    expect(summary).toContain('Pick two of consistency')
    expect(summary).toContain('tokens  120 → 40')
    // Input: the request side, with the system prompt collapsed to a summary.
    stdin.write(RIGHT); await tick()
    const input = lastFrame()!
    expect(input).toContain('SYSTEM')
    expect(input).toContain('be brief')
    expect(input).toContain('What is the CAP theorem?')
  })

  it('a tool-call-only response never renders empty — shows the → name(args) line', async () => {
    const { db } = seedDb([{
      model: 'gpt-4o', tokensIn: 50, tokensOut: 10,
      reqBody: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'where is my order' }] }),
      resBody: JSON.stringify({
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'search_orders', arguments: '{"id":42}' } },
        ] } }],
      }),
    }])
    const id = query.traces(db, { llm: true })[0].id
    const { lastFrame, stdin } = render(<DebugScreen db={db} requestId={id} viewport={V} />)
    await tick()
    stdin.write(RIGHT); await tick()   // Input
    stdin.write(RIGHT); await tick()   // Output
    expect(lastFrame()).toContain('→ search_orders({"id":42})')
  })

  it('tool results render with ✓/✗, name and bytes', async () => {
    const { db } = seedDb([{
      model: 'gpt-4o', tokensIn: 50, tokensOut: 10,
      reqBody: JSON.stringify({
        messages: [
          { role: 'user', content: 'where is my order' },
          { role: 'assistant', content: null, tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'search_orders', arguments: '{}' } },
          ] },
          { role: 'tool', tool_call_id: 'call_a', content: 'shipped' },
        ],
      }),
      resBody: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'It shipped.' } }] }),
    }])
    const id = query.traces(db, { llm: true })[0].id
    const { lastFrame, stdin } = render(<DebugScreen db={db} requestId={id} viewport={V} />)
    await tick()
    stdin.write(RIGHT); await tick()   // Input — the request side carries the result
    expect(lastFrame()).toContain('TOOL RESULT ✓ search_orders')
  })

  it('replaces the ", N cached" phrasing with the fresh/cached/written token block', () => {
    const { db } = seedDb([{
      model: 'gpt-4o', tokensIn: 46802, tokensOut: 846, tokensCached: 46800, tokensCacheWrite: 1024,
      reqBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      resBody: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }),
    }])
    const id = query.traces(db, { llm: true })[0].id
    const f = render(<DebugScreen db={db} requestId={id} />).lastFrame()!
    expect(f).not.toContain('cached)')
    expect(f).not.toContain(', 46,800 cached')
    expect(f).toContain('fresh')
    expect(f).toContain('cached')
    expect(f).toContain('46,800')
    expect(f).toContain('written')
    expect(f).toContain('1,024')
  })
})
