import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRun, createWriter, type StorageDriver } from '@burn0/core'
import { App, TABS } from '../src/tui/App.js'
import { seedDb, baseRow } from './helpers/seed.js'

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))

describe('App shell', () => {
  it('renders first-run onboarding when db is empty, with activation behind ?', async () => {
    const { db } = seedDb([])
    const { lastFrame, stdin } = render(<App db={db} />)
    await tick()
    expect(lastFrame()).toContain('FIRST RUN')
    expect(lastFrame()).toContain('Your API activity will appear here.')
    // Activation commands are troubleshooting info, not a headline step.
    expect(lastFrame()).not.toContain("import 'burn0'")
    stdin.write('?')
    await tick()
    expect(lastFrame()).toContain("import 'burn0'")
    expect(lastFrame()).toContain('bun --import burn0/register')
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

  it('renders exactly one footer line for an open trace (task 16: footer context)', async () => {
    // A traced LLM call, so the LLM tab (index 2) has something to open —
    // TraceListScreen -> TraceView, the nested-screen case the old
    // App-level `FOOTERS[tab]` lookup could not see past (it painted its own
    // stale line above whatever TraceView rendered underneath it).
    const db: StorageDriver = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-shell-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    w.write(
      { opened: [{ localId: 1, parentLocalId: null, name: 'POST /api/chat', kind: 'http-server',
        startedAt: Date.now(), endedAt: Date.now() + 100, status: 200, incomplete: false }], closed: [] },
      [baseRow({ trace: { localId: 1, seq: 0 } })],
    )

    const { stdin, lastFrame } = render(<App db={db} />)
    await tick()
    stdin.write('\t'); await tick()   // Overview -> Usage
    stdin.write('\t'); await tick()   // Usage -> LLM
    expect(lastFrame()).toContain('POST /api/chat')
    stdin.write('\r'); await tick()   // open the trace

    const footerLines = lastFrame()!.split('\n').filter((l) => l.includes('esc back'))
    expect(footerLines).toHaveLength(1)
    expect(footerLines[0]).toContain('h/l fold')
  })
})
