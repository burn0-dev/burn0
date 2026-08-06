import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'
import { seedDb } from './helpers/seed.js'

const tick = () => new Promise((r) => setTimeout(r, 15))

describe('tab actually switches screens', () => {
  it('tab moves Overview -> Usage (cards disappear)', async () => {
    const { db } = seedDb()
    const { lastFrame, stdin } = render(<App db={db} />)
    await tick()
    expect(lastFrame()).toContain('LLM spend')  // overview cards
    stdin.write('\t')
    await tick()
    expect(lastFrame()).not.toContain('LLM spend')  // usage tree now
    expect(lastFrame()).toContain('VENDOR / SERVICE / ENDPOINT')
  })

  it('Logs is the fifth tab and shows LLM and API calls in one stream', async () => {
    const { db } = seedDb([
      { normalizedEndpoint: '/v1/chat/completions' },
      { entity: 'Stripe', entityClass: 'general', provider: null, model: null,
        tokensIn: null, tokensOut: null, costUsd: null,
        hostname: 'api.stripe.com', normalizedEndpoint: '/v1/charges' },
    ])
    const { lastFrame, stdin } = render(<App db={db} />)
    await tick()
    for (let i = 0; i < 4; i++) { stdin.write('\t'); await tick() }
    const f = lastFrame()!
    expect(f).toContain('filter: all')
    expect(f).toContain('/v1/chat/completions')
    expect(f).toContain('/v1/charges')
  })
})

const DOWN = '[B'
const UP = '[A'
const RIGHT = '[C'

describe('overview window selector focus', () => {
  it('down enters selector, right changes window without switching tab', async () => {
    // Seeded 2 days back: visible in the default 30d window, absent from today —
    // so the wrap to `today` has a textual effect to assert on.
    const { db } = seedDb([{ startedAt: Date.now() - 2 * 86_400_000 }])
    const { lastFrame, stdin } = render(<App db={db} />)
    await tick()
    expect(lastFrame()).toContain('LLM spend')
    stdin.write(DOWN)   // enter window selector
    await tick()
    stdin.write(RIGHT)  // 30d -> today (wraps)
    await tick()
    expect(lastFrame()).toContain('No requests in today — try 30d.')  // window changed
    expect(lastFrame()).toContain('WINDOW')                           // still on Overview
    stdin.write(UP)     // leave selector
    await tick()
    stdin.write(RIGHT)  // right switches tab again
    await tick()
    expect(lastFrame()).not.toContain('WINDOW')
    expect(lastFrame()).toContain('VENDOR / SERVICE / ENDPOINT')
  })
})
