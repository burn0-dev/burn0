import { it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'
import { seedDb } from './helpers/seed.js'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const DOWN = '[B'
const ENTER = '\r'
const ESC = ''

it('drills Overview -> entity -> target -> request and escapes back', async () => {
  const { db } = seedDb([
    { model: 'gpt-4o', costUsd: 0.05 },
    { model: 'gpt-4o-mini', costUsd: 0.01 },
    { entity: 'Stripe', entityClass: 'general', provider: null, model: null, costUsd: null,
      tokensIn: null, tokensOut: null, hostname: 'api.stripe.com', normalizedEndpoint: '/v1/charges' },
  ])
  const { lastFrame, stdin } = render(<App db={db} />)
  await tick()
  stdin.write(DOWN); await tick()  // focus window
  stdin.write(DOWN); await tick()  // focus rows (cursor on OpenAI)
  stdin.write(ENTER); await tick()
  let f = lastFrame()!
  expect(f).toContain('Overview / OpenAI')   // entity detail
  expect(f).toContain('MODELS')
  expect(f).toContain('gpt-4o')
  stdin.write(ENTER); await tick()           // open top model target
  f = lastFrame()!
  expect(f).toContain('Overview / OpenAI / gpt-4o')
  expect(f).toContain('REQUESTS (1)')
  stdin.write(ENTER); await tick()           // open request -> DebugScreen
  f = lastFrame()!
  expect(f).toContain('esc back')
  stdin.write(ESC); await tick()             // back to target
  expect(lastFrame()).toContain('Overview / OpenAI / gpt-4o')
  stdin.write(ESC); await tick()             // back to entity
  expect(lastFrame()).toContain('MODELS')
  stdin.write(ESC); await tick()             // back to overview, selection restored
  f = lastFrame()!
  expect(f).toContain('LLM spend')
  stdin.write(ENTER); await tick()           // Enter again opens the SAME entity (cursor restored)
  expect(lastFrame()).toContain('Overview / OpenAI')
})
