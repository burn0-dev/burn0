import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { OverviewScreen } from '../src/tui/screens/Overview.js'
import { seedDb } from './helpers/seed.js'

const seeded = () => seedDb([
  { costUsd: 0.05 },
  { entity: 'Stripe', entityClass: 'general', provider: null, model: null, costUsd: null, status: 500,
    normalizedEndpoint: '/v1/charges' },
])

describe('OverviewScreen', () => {
  it('shows metric strip and entity list ordered llm-cost first', () => {
    const { db } = seeded()
    const f = render(<OverviewScreen db={db} />).lastFrame()!
    expect(f).toContain('LLM spend (30d)')
    expect(f).toContain('$0.0500')
    expect(f).toContain('Error rate')
    expect(f.indexOf('OpenAI')).toBeLessThan(f.indexOf('Stripe'))
  })
})
