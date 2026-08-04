import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { NetworkScreen } from '../src/tui/screens/Network.js'
import { seedDb, baseRow } from './helpers/seed.js'
import { ensureProject, insertRows } from '@burn0/core'

describe('NetworkScreen', () => {
  it('shows existing rows and appends new ones on poll', async () => {
    const { db } = seedDb()
    const { lastFrame } = render(<NetworkScreen db={db} onOpen={() => {}} />)
    expect(lastFrame()).toContain('OpenAI')
    const pid = ensureProject(db, { key: 'path:/x', name: 'test-app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [baseRow({ normalizedEndpoint: '/live/new' })], true)
    await new Promise((r) => setTimeout(r, 1300))
    expect(lastFrame()).toContain('/live/new')
  }, 10_000)
})
