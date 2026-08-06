import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { OverviewScreen } from '../src/tui/screens/Overview.js'
import { seedDb } from './helpers/seed.js'

const noop = () => {}

const seeded = () => seedDb([
  { costUsd: 0.05 },
  { entity: 'Stripe', entityClass: 'general', provider: null, model: null, costUsd: null, status: 500,
    normalizedEndpoint: '/v1/charges' },
])

const view = (db: any) => render(
  <OverviewScreen db={db} windowDays={30} onWindowChange={noop} onOpenEntity={noop} />,
).lastFrame()!

describe('OverviewScreen', () => {
  // Table rows have no card borders — that is what tells a Stripe ROW apart
  // from the 'Most used API' card that also says 'Stripe'.
  const rowLines = (f: string) => f.split('\n').filter((l) => !l.includes('│'))

  it('shows LLM and API metric sections and a grouped dependency list, LLM first', () => {
    const { db } = seeded()
    const f = view(db)
    expect(f).toContain('LLM ACTIVITY')
    expect(f).toContain('API HEALTH')
    expect(f).toContain('LLM spend')
    expect(f).toContain('$0.0500')
    expect(f).toContain('DEPENDENCIES')
    expect(f).not.toContain('AI PROVIDERS')
    expect(f).not.toContain('API SERVICES')
    const openai = rowLines(f).find((l) => l.includes('OpenAI'))!
    const stripe = rowLines(f).find((l) => l.includes('Stripe'))!
    expect(openai).toContain('◆')
    expect(stripe).toContain('◇')
    expect(rowLines(f).indexOf(openai)).toBeLessThan(rowLines(f).indexOf(stripe))
  })

  it('keeps unpriced API rows a gap, never $0.00', () => {
    const { db } = seeded()
    const f = view(db)
    const stripeLine = rowLines(f).find((l) => l.includes('Stripe'))!
    expect(stripeLine).toContain('—')
    expect(stripeLine).not.toContain('$0.00')
  })

  it('shows the scoped-empty window message instead of onboarding', () => {
    const { db } = seedDb([{ startedAt: Date.now() - 2 * 86_400_000 }])
    const f = render(
      <OverviewScreen db={db} windowDays={0} onWindowChange={noop} onOpenEntity={noop} />,
    ).lastFrame()!
    expect(f).toContain('No requests in today — try 30d.')
    expect(f).not.toContain('FIRST RUN')
  })
})
