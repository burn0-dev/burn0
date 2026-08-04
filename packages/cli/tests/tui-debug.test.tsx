import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { DebugScreen } from '../src/tui/screens/Debug.js'
import { seedDb } from './helpers/seed.js'
import { query } from '@burn0/core'

describe('DebugScreen', () => {
  it('prompts when nothing selected', () => {
    const { db } = seedDb([])
    expect(render(<DebugScreen db={db} requestId={null} />).lastFrame()).toContain('Select a request')
  })
  it('renders full request detail with waterfall, bodies, stack, tags', () => {
    const { db } = seedDb([{ tags: { userId: 'u9' }, resTruncated: true }])
    const id = query.traces(db, { llm: true })[0].id
    const f = render(<DebugScreen db={db} requestId={id} />).lastFrame()!
    expect(f).toContain('POST')
    expect(f).toContain('api.openai.com')
    expect(f).toContain('first byte')
    expect(f).toContain('{"model":"gpt-4o"}')
    expect(f).toContain('[truncated at 1MB]')
    expect(f).toContain('server.js:10')
    expect(f).toContain('u9')
  })
})

describe('DebugScreen LLM input/output panels', () => {
  it('shows extracted question and answer side by side', () => {
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
    const f = render(<DebugScreen db={db} requestId={id} />).lastFrame()!
    expect(f).toContain('Input')
    expect(f).toContain('Output')
    expect(f).toContain('What is the CAP theorem?')
    expect(f).toContain('Pick two of consistency')
    expect(f).toContain('120')
    expect(f).toContain('40')
  })
})
