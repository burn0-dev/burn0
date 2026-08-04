import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { TracesScreen } from '../src/tui/screens/Traces.js'
import { seedDb } from './helpers/seed.js'

const tick = () => new Promise((r) => setTimeout(r, 10))

const seeded = () => seedDb([
  { model: 'gpt-4o', costUsd: 0.01, tokensIn: 100, tokensOut: 20 },
  { entity: 'Stripe', entityClass: 'general', provider: null, model: null, costUsd: null,
    normalizedEndpoint: '/v1/charges', method: 'GET' },
])

describe('TracesScreen', () => {
  it('llm=true lists only llm rows with model, tokens, cost, project', () => {
    const { db } = seeded()
    const f = render(<TracesScreen db={db} llm onOpen={() => {}} />).lastFrame()!
    expect(f).toContain('gpt-4o')
    expect(f).toContain('$0.0100')
    expect(f).toContain('test-app')
    expect(f).not.toContain('Stripe')
  })
  it('llm=false lists only general rows', () => {
    const { db } = seeded()
    const f = render(<TracesScreen db={db} llm={false} onOpen={() => {}} />).lastFrame()!
    expect(f).toContain('Stripe')
    expect(f).toContain('/v1/charges')
    expect(f).not.toContain('gpt-4o')
  })
  it('enter opens selected row', async () => {
    const { db } = seeded()
    const onOpen = vi.fn()
    const { stdin, lastFrame } = render(<TracesScreen db={db} llm onOpen={onOpen} />)
    await tick()
    stdin.write('\r')
    await tick()
    expect(onOpen).toHaveBeenCalledWith(expect.any(Number))
  })
})
