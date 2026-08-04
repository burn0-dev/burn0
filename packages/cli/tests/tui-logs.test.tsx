import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { insertRows, ensureProject, type StorageDriver } from '@burn0/core'
import type { EnrichedRow } from '@burn0/core'
import { LogsScreen } from '../src/tui/screens/Logs.js'
import { seedDb, baseRow } from './helpers/seed.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
// The ESC byte is not optional: a bare '[A' arrives as two printable characters
// and ink never reports key.upArrow.
const UP = '\u001B[A'
const DOWN = '\u001B[B'

function api(over: Partial<EnrichedRow>): Partial<EnrichedRow> {
  return {
    entity: 'Stripe', entityClass: 'general', provider: null, model: null,
    tokensIn: null, tokensOut: null, costUsd: null,
    hostname: 'api.stripe.com', normalizedEndpoint: '/v1/charges', ...over,
  }
}

/** Append rows to a live db the way a running app would. */
function append(db: StorageDriver, rows: Partial<EnrichedRow>[]) {
  const pid = ensureProject(db, { key: 'path:/x', name: 'test-app', rootPath: '/x', gitRoot: null })
  insertRows(db, pid, rows.map(baseRow), true)
}

const noop = () => {}

describe('LogsScreen', () => {
  it('interleaves LLM and API calls in one stream, newest first', async () => {
    const now = Date.now()
    const { db } = seedDb([
      { startedAt: now - 3000, normalizedEndpoint: '/v1/chat/completions' },
      api({ startedAt: now - 2000 }),
      { startedAt: now - 1000, normalizedEndpoint: '/v1/embeddings' },
    ])
    const { lastFrame } = render(<LogsScreen db={db} onOpen={noop} />)
    await tick()
    const f = lastFrame()!
    expect(f).toContain('/v1/embeddings')
    expect(f).toContain('/v1/charges')
    expect(f).toContain('/v1/chat/completions')
    // newest first: the last-inserted row renders above the first-inserted one
    expect(f.indexOf('/v1/embeddings')).toBeLessThan(f.indexOf('/v1/chat/completions'))
  })

  it('follows new rows as they arrive', async () => {
    const { db } = seedDb([{ normalizedEndpoint: '/v1/chat/completions' }])
    const { lastFrame } = render(<LogsScreen db={db} onOpen={noop} />)
    await tick()
    expect(lastFrame()).not.toContain('/v1/charges')
    append(db, [api({})])
    await tick(1200)
    expect(lastFrame()).toContain('/v1/charges')
  })

  it('pressing up pauses following — tail -f semantics', async () => {
    const { db } = seedDb([
      { normalizedEndpoint: '/v1/chat/completions' },
      { normalizedEndpoint: '/v1/embeddings' },
    ])
    const { lastFrame, stdin } = render(<LogsScreen db={db} onOpen={noop} />)
    await tick()
    expect(lastFrame()).toContain('following')

    stdin.write(UP)
    await tick()
    expect(lastFrame()).toContain('paused')

    // rows still arrive and are still shown — pausing stops the cursor moving,
    // it does not stop capture and it never hides data
    append(db, [api({})])
    await tick(1200)
    expect(lastFrame()).toContain('paused')
    expect(lastFrame()).toContain('/v1/charges')

    stdin.write('f')   // resume
    await tick()
    expect(lastFrame()).toContain('following')
  })

  it('cycles the filter through all / llm / api / errors', async () => {
    const { db } = seedDb([
      { normalizedEndpoint: '/v1/chat/completions' },
      api({ status: 500 }),
      api({ normalizedEndpoint: '/v1/customers', status: 200 }),
    ])
    const { lastFrame, stdin } = render(<LogsScreen db={db} onOpen={noop} />)
    await tick()
    expect(lastFrame()).toContain('filter: all')

    stdin.write('/')
    await tick()
    expect(lastFrame()).toContain('filter: llm')
    expect(lastFrame()).toContain('/v1/chat/completions')
    expect(lastFrame()).not.toContain('/v1/customers')

    stdin.write('/')
    await tick()
    expect(lastFrame()).toContain('filter: api')
    expect(lastFrame()).not.toContain('/v1/chat/completions')
    expect(lastFrame()).toContain('/v1/customers')

    stdin.write('/')
    await tick()
    expect(lastFrame()).toContain('filter: errors')
    expect(lastFrame()).toContain('/v1/charges')      // the 500
    expect(lastFrame()).not.toContain('/v1/customers') // the 200
  })

  it('renders an unpriced call as a gap, never as $0.00', async () => {
    const { db } = seedDb([api({})])
    const { lastFrame } = render(<LogsScreen db={db} onOpen={noop} />)
    await tick()
    expect(lastFrame()).not.toContain('$0.00')
  })

  it('pages older rows in rather than stopping at the first window', async () => {
    // 60 rows against a 24-row test terminal: the tail is only reachable by paging
    const rows = Array.from({ length: 60 }, (_, i) =>
      api({ normalizedEndpoint: `/ep${String(i).padStart(2, '0')}` }))
    const { db } = seedDb(rows)
    const { lastFrame, stdin } = render(<LogsScreen db={db} onOpen={noop} />)
    await tick()
    expect(lastFrame()).toContain('/ep59')   // newest
    expect(lastFrame()).not.toContain('/ep00')

    // pressed in batches, as a human would — paging happens between renders
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 8; i++) stdin.write(DOWN)
      await tick(40)
    }
    expect(lastFrame()).toContain('/ep00')   // oldest reached
  })

  it('opens the request under the cursor', async () => {
    const { db } = seedDb([{ normalizedEndpoint: '/v1/chat/completions' }])
    const opened: number[] = []
    const { stdin } = render(<LogsScreen db={db} onOpen={(id) => opened.push(id)} />)
    await tick()
    stdin.write('\r')
    await tick()
    expect(opened).toHaveLength(1)
  })
})
