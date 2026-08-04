import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { UsageScreen } from '../src/tui/screens/Usage.js'
import { seedDb } from './helpers/seed.js'
import type { EnrichedRow } from '@burn0/core'

const tick = () => new Promise((r) => setTimeout(r, 15))
// The ESC byte is not optional: a bare '[B' arrives as two printable characters
// and ink never reports key.downArrow.
const DOWN = '\u001B[B'

/** A non-LLM row: no model, no tokens, no price. */
function api(over: Partial<EnrichedRow>): Partial<EnrichedRow> {
  return {
    entityClass: 'general', provider: null, model: null,
    tokensIn: null, tokensOut: null, costUsd: null, ...over,
  }
}

describe('UsageScreen', () => {
  it('lands on vendors with their children already visible', async () => {
    const { db } = seedDb([
      api({ hostname: 'api.resend.com', method: 'POST', normalizedEndpoint: '/emails' }),
      api({ hostname: 'api.resend.com', method: 'POST', normalizedEndpoint: '/emails' }),
      api({ hostname: 'api.resend.com', method: 'GET', normalizedEndpoint: '/domains' }),
    ])
    const { lastFrame } = render(<UsageScreen db={db} />)
    await tick()
    const f = lastFrame()!
    expect(f).toContain('Resend')
    // vendor > service > host all had one child and collapsed away (core does this)
    expect(f).toContain('POST /emails')
    expect(f).toContain('GET /domains')
  })

  it('collapses below the first level until expanded', async () => {
    const { db } = seedDb([
      // two S3 calls to one Bedrock call, so S3 sorts first and the cursor
      // position below is not at the mercy of a tie-break
      api({ hostname: 's3.us-east-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key' }),
      api({ hostname: 's3.us-east-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key' }),
      api({ hostname: 'bedrock-runtime.us-east-1.amazonaws.com', method: 'POST', normalizedEndpoint: '/model/:id/invoke' }),
    ])
    const { lastFrame, stdin } = render(<UsageScreen db={db} />)
    await tick()
    expect(lastFrame()).toContain('AWS')
    expect(lastFrame()).toContain('s3')            // depth 1 visible
    expect(lastFrame()).not.toContain('/:bucket/:key')  // depth 2 hidden

    stdin.write(DOWN)   // cursor onto the s3 service row
    await tick()
    stdin.write('l')    // expand
    await tick()
    expect(lastFrame()).toContain('/:bucket/:key')

    stdin.write('h')    // collapse again
    await tick()
    expect(lastFrame()).not.toContain('/:bucket/:key')
  })

  it('renders unpriced calls as a gap, never as $0.00', async () => {
    const { db } = seedDb([
      api({ hostname: 'api.resend.com', method: 'POST', normalizedEndpoint: '/emails' }),
    ])
    const { lastFrame } = render(<UsageScreen db={db} />)
    await tick()
    expect(lastFrame()).not.toContain('$0.00')
    expect(lastFrame()).toContain('—')
  })

  it('renders unmeasured byte volume as a gap, never as 0', async () => {
    const { db } = seedDb([
      // captured through the undici DC path: metadata only, bytes never observed
      api({ hostname: 'api.pinecone.io', method: 'POST', normalizedEndpoint: '/query',
        reqBytes: null, resBytes: null }),
    ])
    const { lastFrame } = render(<UsageScreen db={db} />)
    await tick()
    expect(lastFrame()).not.toContain('0 B')
  })

  it('shows tokens instead of bytes for LLM rows', async () => {
    const { db } = seedDb([
      { hostname: 'api.openai.com', method: 'POST', normalizedEndpoint: '/v1/chat/completions',
        tokensIn: 1204, tokensOut: 380, costUsd: 0.0142, reqBytes: 900, resBytes: 2400 },
    ])
    const { lastFrame } = render(<UsageScreen db={db} />)
    await tick()
    const f = lastFrame()!
    expect(f).toContain('1,204')   // tokens, not the 900/2400 byte figures
    expect(f).toContain('380')
    expect(f).toContain('$0.0142')
  })

  it('scrolls to the tail rather than truncating the list', async () => {
    // more vendors than fit the 24-row test terminal
    const rows = Array.from({ length: 30 }, (_, i) =>
      api({ hostname: `api.vendor${String(i).padStart(2, '0')}.com`, method: 'GET', normalizedEndpoint: '/ping' }))
    const { db } = seedDb(rows)
    const { lastFrame, stdin } = render(<UsageScreen db={db} />)
    await tick()
    expect(lastFrame()).toContain('vendor00')
    expect(lastFrame()).not.toContain('vendor29')

    for (let i = 0; i < 80; i++) stdin.write(DOWN)   // cursor clamps at the last row
    await tick()
    expect(lastFrame()).toContain('vendor29')   // the tail is reachable
  })
})
