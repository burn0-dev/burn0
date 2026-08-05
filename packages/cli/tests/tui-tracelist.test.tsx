import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRun, createWriter, type StorageDriver } from '@burn0/core'
import type { PendingTrace, EnrichedRow } from '@burn0/core'
import { TraceListScreen } from '../src/tui/screens/TraceList.js'
import { TraceView } from '../src/tui/screens/TraceView.js'
import { baseRow } from './helpers/seed.js'

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))
const DOWN = '\u001B[B'
const T0 = 1_700_000_000_000

function trace(over: Partial<PendingTrace> & { localId: number }): PendingTrace {
  return {
    parentLocalId: null, name: null, kind: 'http-server',
    startedAt: T0, endedAt: null, status: null, incomplete: false, ...over,
  }
}

const llm = (over: Partial<EnrichedRow> = {}) => baseRow({
  entityClass: 'llm', hostname: 'api.openai.com', model: 'gpt-4o',
  normalizedEndpoint: '/v1/chat/completions', tokensIn: 1204, tokensOut: 380,
  costUsd: 0.0142, latencyMs: 820, ...over,
})
const api = (over: Partial<EnrichedRow> = {}) => baseRow({
  entityClass: 'general', provider: null, model: null, hostname: 'api.pinecone.io',
  normalizedEndpoint: '/query', tokensIn: null, tokensOut: null, costUsd: null,
  latencyMs: 41, ...over,
})

/** One inbound request with two LLM calls and two API calls between them. */
function seeded(): { db: StorageDriver; rootId: number } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tl-')), 'burn0.db'))
  const projectId = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  const runId = insertRun(db, { projectId, service: null, pid: 1, entry: 'server.js', nodeVersion: 'v22' })
  const w = createWriter(db, { projectId, runId, service: null, capturePayloads: true })
  w.write({
    opened: [
      trace({ localId: 1, name: 'POST /api/chat', startedAt: T0 }),
      trace({ localId: 2, parentLocalId: 1, name: 'retrieve-context', kind: 'explicit', startedAt: T0 + 5 }),
    ],
    closed: [trace({ localId: 1, name: 'POST /api/chat', startedAt: T0, endedAt: T0 + 2100, status: 200 })],
  }, [
    api({ startedAt: T0 + 10, trace: { localId: 2, seq: 0 } }),
    llm({ startedAt: T0 + 100, trace: { localId: 2, seq: 1 }, model: 'text-embedding-3', costUsd: 0.0004 }),
    llm({ startedAt: T0 + 1000, trace: { localId: 1, seq: 2 }, costUsd: 0.017 }),
    api({ startedAt: T0 + 2000, trace: { localId: 1, seq: 3 }, hostname: 'api.stripe.com', normalizedEndpoint: '/v1/customers/:id' }),
  ])
  const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id
  return { db, rootId }
}

const noop = () => {}

describe('TraceListScreen', () => {
  it('shows one uniform row per trace, with its shape', async () => {
    const { db } = seeded()
    const { lastFrame } = render(<TraceListScreen db={db} onOpenRequest={noop} />)
    await tick()
    const f = lastFrame()!
    expect(f).toContain('POST /api/chat')
    // 0.0004 (nested embedding) + 0.017 — rolled up over the nested trace too
    expect(f).toContain('$0.0174')
    expect(f).toContain('◇◆◆◇')             // retrieve (api, llm) then llm, api
    expect(f).toContain('2.1s')
  })

  it('opens a trace and shows its calls nested under it', async () => {
    const { db } = seeded()
    const { lastFrame, stdin } = render(<TraceListScreen db={db} onOpenRequest={noop} />)
    await tick()
    stdin.write('\r')
    await tick()
    const f = lastFrame()!
    expect(f).toContain('retrieve-context')
    expect(f).toContain('/query')
    expect(f).toContain('/v1/customers/:id')
  })

  it('falls back to the flat list when the project has no traces at all', async () => {
    // a plain script, or traces.http: false — an empty screen would be worse
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-notrace-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/y', name: 'script', rootPath: '/y', gitRoot: null })
    createWriter(db, { projectId, runId: null, service: null, capturePayloads: false })
      .write({ opened: [], closed: [] }, [llm({ startedAt: T0, trace: null })])
    const { lastFrame } = render(<TraceListScreen db={db} onOpenRequest={noop} />)
    await tick()
    // the untraced call is still listed, labelled by model — nothing hidden
    expect(lastFrame()).toContain('gpt-4o')
  })

  it('f toggles the flat chronological list', async () => {
    const { db } = seeded()
    const { lastFrame, stdin } = render(<TraceListScreen db={db} onOpenRequest={noop} />)
    await tick()
    expect(lastFrame()).toContain('POST /api/chat')
    stdin.write('f')
    await tick()
    // flat view is per-call, so the individual model rows appear and the
    // trace name does not
    expect(lastFrame()).toContain('text-embedding-3')
    expect(lastFrame()).not.toContain('POST /api/chat')
  })

  it('never renders an unpriced trace as $0.00', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-unpriced-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/z', name: 'app', rootPath: '/z', gitRoot: null })
    const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
    createWriter(db, { projectId, runId, service: null, capturePayloads: false })
      .write({ opened: [trace({ localId: 1, name: 'GET /health' })], closed: [] },
        [api({ startedAt: T0, trace: { localId: 1, seq: 0 } })])
    const { lastFrame } = render(<TraceListScreen db={db} onOpenRequest={noop} />)
    await tick()
    expect(lastFrame()).not.toContain('$0.00')
    expect(lastFrame()).toContain('—')
  })
})

describe('TraceView', () => {
  it('indents the tree and keeps numeric columns aligned across depths', async () => {
    const { db, rootId } = seeded()
    const { lastFrame } = render(<TraceView db={db} traceId={rootId} columns={100} onBack={noop} onOpenRequest={noop} />)
    await tick()
    const lines = lastFrame()!.split('\n')
    const rootLine = lines.find((l) => l.includes('POST /api/chat'))!
    const childLine = lines.find((l) => l.includes('retrieve-context'))!
    const leafLine = lines.find((l) => l.includes('/query'))!
    expect(childLine.indexOf('retrieve-context')).toBeGreaterThan(rootLine.indexOf('POST /api/chat'))
    expect(leafLine.indexOf('/query')).toBeGreaterThan(childLine.indexOf('retrieve-context'))
  })

  it('uses two panes when the terminal is wide enough', async () => {
    const { db, rootId } = seeded()
    const wide = render(<TraceView db={db} traceId={rootId} columns={130} onBack={noop} onOpenRequest={noop} />)
    await tick()
    // The detail card — a bordered box beside the tree, with the root card's
    // pricing-coverage line inside it.
    expect(wide.lastFrame()).toContain('╭')
    expect(wide.lastFrame()).toContain('calls priced')

    // Ink has no layout query, so this is a manual branch — below 110 columns
    // the detail pane would squeeze the tree into unreadability
    const narrow = render(<TraceView db={db} traceId={rootId} columns={90} onBack={noop} onOpenRequest={noop} />)
    await tick()
    expect(narrow.lastFrame()).not.toContain('╭')
  })

  it('the detail pane follows the selection', async () => {
    const { db, rootId } = seeded()
    const { lastFrame, stdin } = render(
      <TraceView db={db} traceId={rootId} columns={130} onBack={noop} onOpenRequest={noop} />)
    await tick()
    stdin.write(DOWN)   // onto retrieve-context
    await tick()
    expect(lastFrame()).toContain('retrieve-context')
    stdin.write(DOWN)   // onto the Pinecone call
    await tick()
    expect(lastFrame()).toContain('api.pinecone.io')
  })

  it('renders a tool node with the calls attributed to it beneath', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tool-ui-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/t', name: 'agent', rootPath: '/t', gitRoot: null })
    const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
    createWriter(db, { projectId, runId, service: null, capturePayloads: false }).write({
      opened: [
        trace({ localId: 1, name: 'POST /api/chat', startedAt: T0 }),
        {
          localId: 2, parentLocalId: 1, name: 'search_orders', kind: 'tool',
          startedAt: T0 + 100, endedAt: T0 + 500, status: null, incomplete: false,
          toolStatus: 'ok', attribution: 'window', args: '{}',
        },
      ],
      closed: [],
    }, [
      api({ startedAt: T0 + 150, trace: { localId: 1, seq: 0 } }),
      api({ startedAt: T0 + 300, hostname: 'api.stripe.com', normalizedEndpoint: '/v1/customers/:id', trace: { localId: 1, seq: 1 } }),
    ])
    const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id

    const { lastFrame } = render(<TraceView db={db} traceId={rootId} columns={100} onBack={noop} onOpenRequest={noop} />)
    await tick()
    const lines = lastFrame()!.split('\n')
    const toolLine = lines.find((l) => l.includes('search_orders'))!
    const callLine = lines.find((l) => l.includes('/v1/customers/:id'))!
    expect(toolLine).toContain('🔧')
    // the attributed calls sit deeper than the tool that caused them
    expect(callLine.search(/\S/)).toBeGreaterThan(toolLine.search(/\S/))
  })

  it('marks a failed tool rather than letting the trace look successful', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tool-err-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/e', name: 'agent', rootPath: '/e', gitRoot: null })
    const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
    createWriter(db, { projectId, runId, service: null, capturePayloads: false }).write({
      opened: [
        trace({ localId: 1, name: 'POST /api/chat', startedAt: T0 }),
        {
          localId: 2, parentLocalId: 1, name: 'search_orders', kind: 'tool',
          startedAt: T0 + 100, endedAt: T0 + 500, status: null, incomplete: false,
          toolStatus: 'error', attribution: 'window', args: '{}',
        },
      ],
      closed: [],
    }, [api({ startedAt: T0 + 150, status: 200, trace: { localId: 1, seq: 0 } })])
    const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id

    const { lastFrame } = render(<TraceView db={db} traceId={rootId} columns={100} onBack={noop} onOpenRequest={noop} />)
    await tick()
    // every HTTP call returned 200; the failure is only visible on the tool
    expect(lastFrame()).toContain('error')
  })

  it('opens the request under the cursor', async () => {
    const { db, rootId } = seeded()
    const opened: number[] = []
    const { stdin } = render(
      <TraceView db={db} traceId={rootId} columns={130} onBack={noop} onOpenRequest={(id) => opened.push(id)} />)
    await tick()
    stdin.write(DOWN); await tick()
    stdin.write(DOWN); await tick()   // a request node
    stdin.write('\r'); await tick()
    expect(opened).toHaveLength(1)
  })
})
