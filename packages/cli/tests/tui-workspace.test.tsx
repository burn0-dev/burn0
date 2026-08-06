import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stringWidth from 'string-width'
import {
  openDatabase, ensureProject, insertRun, createWriter, type StorageDriver,
} from '@burn0/core'
import type { PendingTrace, EnrichedRow } from '@burn0/core'
import { App } from '../src/tui/App.js'
import { TraceListScreen } from '../src/tui/screens/TraceList.js'
import { DebugScreen } from '../src/tui/screens/Debug.js'
import { baseRow, seedDb } from './helpers/seed.js'
import { query } from '@burn0/core'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const DOWN = '[B'
const RIGHT = '[C'
const T0 = Date.now() - 60_000
const noop = () => {}

const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '')
const lines = (frame: string) => stripAnsi(frame).split('\n')

function trace(over: Partial<PendingTrace> & { localId: number }): PendingTrace {
  return {
    parentLocalId: null, name: null, kind: 'http-server',
    startedAt: T0, endedAt: T0 + 2000, status: 200, incomplete: false, ...over,
  }
}

const llm = (over: Partial<EnrichedRow> = {}) => baseRow({
  entityClass: 'llm', hostname: 'api.anthropic.com', model: 'claude-sonnet-5',
  normalizedEndpoint: '/v1/messages', tokensIn: 46_802, tokensOut: 846,
  tokensCached: 44_100, costUsd: 0.0203, latencyMs: 5600, ...over,
})
const api = (over: Partial<EnrichedRow> = {}) => baseRow({
  entityClass: 'general', provider: null, model: null,
  hostname: 'my-tenant.s4hanacloud.sap.com',
  normalizedEndpoint: '/s4hanacloud/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder',
  tokensIn: null, tokensOut: null, tokensCached: null, costUsd: null, latencyMs: 620, ...over,
})

function seedTraced(name = 'POST /api/chat', at = T0): { db: StorageDriver; write: (n: string, when: number) => void } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-ws-')), 'burn0.db'))
  const projectId = ensureProject(db, { key: 'path:/w', name: 'app', rootPath: '/w', gitRoot: null })
  const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
  const w = createWriter(db, { projectId, runId, service: null, capturePayloads: true })
  let nextLocal = 1
  const write = (n: string, when: number) => {
    const localId = nextLocal++
    w.write({ opened: [trace({ localId, name: n, startedAt: when, endedAt: when + 2000 })], closed: [] }, [
      llm({ startedAt: when + 100, trace: { localId, seq: 0 } }),
      api({ startedAt: when + 1000, trace: { localId, seq: 1 } }),
    ])
  }
  write(name, at)
  return { db, write }
}

// ---------------------------------------------------------------------------

describe('workspace width contract (inside the real App shell)', () => {
  const WIDTHS = [80, 90, 109, 110, 140, 159, 160, 200]

  it('every rendered line fits the terminal at every boundary width — list and open trace', async () => {
    for (const columns of WIDTHS) {
      const { db } = seedTraced()
      const { lastFrame, stdin } = render(
        <App db={db} size={{ columns, rows: 30 }} />)
      await tick()
      stdin.write('\t'); await tick()   // Usage
      stdin.write('\t'); await tick()   // LLM tab

      for (const l of lines(lastFrame()!)) {
        expect(stringWidth(l), `list @${columns}: "${l}"`).toBeLessThanOrEqual(columns)
      }

      stdin.write('\r'); await tick()   // open the trace (or focus tree in wide)
      for (const l of lines(lastFrame()!)) {
        expect(stringWidth(l), `tree @${columns}: "${l}"`).toBeLessThanOrEqual(columns)
      }

      // Optional tree columns disappear as whole units — a sheared header
      // such as `TO…` is a failure at any width.
      expect(lastFrame()!).not.toContain('TO…')
      expect(lastFrame()!).not.toContain('TOKEN…')
    }
  })

  it('wide mode is a persistent three-pane workspace with aligned pane headers', async () => {
    const { db } = seedTraced()
    const { lastFrame, stdin } = render(
      <TraceListScreen db={db} viewport={{ columns: 200, rows: 28 }} onOpenRequest={noop} />)
    await tick()
    const f = stripAnsi(lastFrame()!)
    expect(f).toContain('TRACES')
    expect(f).toContain('EXECUTION')
    expect(f).toContain('DETAIL')
    // All three pane headers occupy the same first row.
    const head = f.split('\n')[0]
    expect(head).toContain('TRACES')
    expect(head).toContain('EXECUTION')
    expect(head).toContain('DETAIL')

    // ← / → move pane focus without navigating; the tree cursor works when
    // the tree holds focus.
    stdin.write(RIGHT); await tick()  // list -> tree
    stdin.write(DOWN); await tick()   // tree cursor moves — inspector follows
    expect(stripAnsi(lastFrame()!)).toContain('claude-sonnet-5')
  })
})

describe('trace-list selection is identity-based (live inserts)', () => {
  it('keeps the selected trace when a newer one is inserted, unless following the newest', async () => {
    const { db, write } = seedTraced('POST /api/older', T0)
    write('POST /api/newer', T0 + 5000)
    const { lastFrame, stdin } = render(
      <TraceListScreen db={db} viewport={{ columns: 100, rows: 24 }} onOpenRequest={noop} />)
    await tick()
    stdin.write(DOWN); await tick()   // cursor: newest -> the older trace

    write('POST /api/newest', T0 + 10_000)   // lands at the top mid-poll
    await tick(1200)
    expect(stripAnsi(lastFrame()!)).toContain('POST /api/newest')

    stdin.write('\r'); await tick()          // open the SELECTED trace
    // Identity held: it is still the older trace, not whatever slid into
    // the old index.
    const f = stripAnsi(lastFrame()!)
    expect(f).toContain('POST /api/older')
    expect(f).not.toContain('POST /api/newest')
  })

  it('a cursor already on the newest row follows the tail', async () => {
    const { db, write } = seedTraced('POST /api/first', T0)
    const { lastFrame, stdin } = render(
      <TraceListScreen db={db} viewport={{ columns: 100, rows: 24 }} onOpenRequest={noop} />)
    await tick()                              // cursor on the newest (only) row

    write('POST /api/fresh', T0 + 5000)
    await tick(1200)
    stdin.write('\r'); await tick()
    expect(stripAnsi(lastFrame()!)).toContain('POST /api/fresh')
  })
})

describe('request detail viewport', () => {
  const V = { columns: 80, rows: 18 }

  function bigLlm() {
    const messages: any[] = [{ role: 'system', content: 'You are helpful. Be concise always.' }]
    for (let i = 0; i < 60; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}: ${'lorem ipsum '.repeat(12)}` })
    }
    messages.push({ role: 'user', content: 'final question about the CAP theorem' })
    const sse = [
      'event: message_start',
      'data: {"type":"message_start"}',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer: pick two."}}',
      'data: [DONE]',
    ].join('\n')
    return seedDb([{
      model: 'claude-sonnet-5', tokensIn: 9000, tokensOut: 120, costUsd: 0.01,
      reqBody: JSON.stringify({ model: 'claude-sonnet-5', messages }),
      resBody: sse,
    }])
  }

  it('never renders more rows than the viewport, on every tab', async () => {
    const { db } = bigLlm()
    const id = query.traces(db, { llm: true })[0].id
    const { lastFrame, stdin } = render(<DebugScreen db={db} requestId={id} viewport={V} />)
    await tick()
    for (let t = 0; t < 5; t++) {
      const ls = lines(lastFrame()!)
      expect(ls.length, `tab ${t}`).toBeLessThanOrEqual(V.rows)
      for (const l of ls) expect(stringWidth(l), `tab ${t}: "${l}"`).toBeLessThanOrEqual(V.columns)
      stdin.write(RIGHT); await tick()
    }
  })

  it('keeps SSE frames and transport headers out of Input/Output; Raw carries them', async () => {
    const { db } = bigLlm()
    const id = query.traces(db, { llm: true })[0].id
    const { lastFrame, stdin } = render(<DebugScreen db={db} requestId={id} viewport={V} />)
    await tick()

    stdin.write(RIGHT); await tick()          // Input
    stdin.write('G'); await tick()            // bottom — still no protocol frames
    const input = stripAnsi(lastFrame()!)
    expect(input).not.toContain('data:')
    expect(input).not.toContain('content-type')
    expect(input).toContain('final question about the CAP theorem')

    stdin.write(RIGHT); await tick()          // Output
    const output = stripAnsi(lastFrame()!)
    expect(output).not.toContain('event: message_start')

    stdin.write(RIGHT); await tick()          // Metadata
    stdin.write(RIGHT); await tick()          // Raw
    stdin.write('G'); await tick()            // scroll to the end
    const raw = stripAnsi(lastFrame()!)
    expect(raw).toContain('data:')
  })

  it('scrolls: a long Input history is reachable line by line and via G', async () => {
    const { db } = bigLlm()
    const id = query.traces(db, { llm: true })[0].id
    const { lastFrame, stdin } = render(<DebugScreen db={db} requestId={id} viewport={V} />)
    await tick()
    stdin.write(RIGHT); await tick()          // Input
    const top = stripAnsi(lastFrame()!)
    expect(top).toContain('SYSTEM')
    stdin.write('G'); await tick()            // end of the history
    const bottom = stripAnsi(lastFrame()!)
    expect(bottom).not.toBe(top)
    expect(bottom).toContain('final question about the CAP theorem')
  })
})
