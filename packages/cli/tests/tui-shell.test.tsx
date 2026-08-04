import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { App, TABS } from '../src/tui/App.js'
import { seedDb } from './helpers/seed.js'

describe('App shell', () => {
  it('renders onboarding when db is empty', () => {
    const { db } = seedDb([])
    const { lastFrame } = render(<App db={db} />)
    expect(lastFrame()).toContain('No requests captured yet')
    expect(lastFrame()).toContain("import 'burn0'")
  })
  it('renders tab row and data with a seeded db', () => {
    const { db } = seedDb()
    const { lastFrame } = render(<App db={db} />)
    for (const t of TABS) expect(lastFrame()).toContain(t)
    expect(lastFrame()).toContain('OpenAI')
  })
  it('tab key cycles to the Usage screen', () => {
    const { db } = seedDb()
    const { stdin, lastFrame } = render(<App db={db} />)
    stdin.write('\t')
    expect(lastFrame()).toContain('Usage')
  })
})
