import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openDatabase, ensureProject, insertRun, createWriter, type StorageDriver,
} from '@burn0/core'
import type { PendingTrace, EnrichedRow } from '@burn0/core'
import { TraceView, computeLayout } from '../src/tui/screens/TraceView.js'
import { baseRow, seedDb } from './helpers/seed.js'

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))
// The ESC byte is not optional: a bare '[B' is delivered as two printable
// characters and `key.downArrow` never fires (see progress.md).
const UP = '\u001B[A'
const DOWN = '\u001B[B'

const noop = () => {}

/** The detail pane repeats the selected row's identity, so "the cursor is on X"
 *  is observable as X appearing twice — once in the tree, once in the card. */
const occurrences = (frame: string, needle: string) => frame.split(needle).length - 1

const T0 = 1_770_000_000_000
const SAP_HOST = 'my-tenant.s4hanacloud.sap.com'
const LLM_HOST = 'api.anthropic.com'
const SAP_PREFIX = '/s4hanacloud/sap/opu/odata/sap/'
const ROOT_LABEL = 'POST /api/conversations/:id/chat'
const MODEL = 'claude-sonnet-5'
const TOOL_LABEL = 'sap_execute_sap_operation'

// The twelve `$metadata` discovery probes — the fold wall — one host, one verb.
const DISCOVERY = [
  'API_SALES_ORDER_SRV/$metadata',
  'API_BUSINESS_PARTNER/$metadata',
  'API_PRODUCT_SRV/$metadata',
  'API_MATERIAL_STOCK_SRV/$metadata',
  'API_PURCHASEORDER_PROCESS_SRV/$metadata',
  'API_SUPPLIER_INVOICE_SRV/$metadata',
  'API_BILLING_DOCUMENT_SRV/$metadata',
  'API_OUTBOUND_DELIVERY_SRV/$metadata',
  'API_CUSTOMER_RETURN_SRV/$metadata',
  'API_JOURNALENTRYITEMBASIC_SRV/$metadata',
  'API_COSTCENTER_SRV/$metadata',
  'API_OPLACCTGDOCITEMCUBE_SRV/$metadata',
]

function apiCall(o: { at: number; ms: number; endpoint: string; method?: string; status?: number }): Partial<EnrichedRow> {
  return {
    startedAt: T0 + o.at, latencyMs: o.ms, method: o.method ?? 'GET',
    hostname: SAP_HOST, normalizedEndpoint: SAP_PREFIX + o.endpoint,
    entityClass: 'general', provider: null, model: null,
    tokensIn: null, tokensOut: null, tokensCached: null, costUsd: null,
    status: o.status ?? 200,
  }
}

function llmCall(o: { at: number; ms: number; tin: number; cached: number; tout: number; cost: number }): Partial<EnrichedRow> {
  return {
    startedAt: T0 + o.at, latencyMs: o.ms, method: 'POST',
    hostname: LLM_HOST, normalizedEndpoint: '/v1/messages',
    entityClass: 'llm', provider: null, model: MODEL,
    tokensIn: o.tin, tokensOut: o.tout, tokensCached: o.cached, costUsd: o.cost,
    status: 200,
  }
}

/** The spec §2.6 reference-trace *shape*, seeded through a real writer: root +
 *  twelve same-host discovery GETs (the fold wall) + two `claude-sonnet-5`
 *  turns, each followed by a tool whose SAP children arrive within its
 *  attribution window (§8.4) rather than addressed to it directly — the same
 *  mechanism a live agent server uses. */
function seedReferenceLikeTrace(): { db: StorageDriver; rootId: number; w: ReturnType<typeof createWriter> } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tv-')), 'burn0.db'))
  const projectId = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
  const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })

  const overrides: Partial<EnrichedRow>[] = []
  let seq = 0
  const attach = (o: Partial<EnrichedRow>) => overrides.push({ trace: { localId: 1, seq: seq++ }, ...o })

  DISCOVERY.forEach((endpoint, i) => {
    attach(apiCall({ at: i * 175, ms: i === 11 ? 175 : 170, endpoint }))
  })

  const TURNS = [
    {
      at: 2100, ms: 5600, tin: 46_900, cached: 44_100, tout: 412, cost: 0.0203,
      toolLocalId: 2, toolAt: 7700, toolMs: 1400,
      kids: [
        { at: 50, ms: 620, endpoint: 'API_SALES_ORDER_SRV/A_SalesOrder' },
        { at: 800, ms: 180, endpoint: 'API_SALES_ORDER_SRV/A_SalesOrder/$count' },
      ],
    },
    {
      at: 9100, ms: 3200, tin: 47_300, cached: 45_200, tout: 380, cost: 0.0206,
      toolLocalId: 3, toolAt: 12_300, toolMs: 1200,
      kids: [
        { at: 50, ms: 500, endpoint: 'API_BUSINESS_PARTNER/A_BusinessPartner' },
        { at: 600, ms: 400, endpoint: 'API_BUSINESS_PARTNER/A_Customer' },
      ],
    },
  ]

  const tools: PendingTrace[] = []
  TURNS.forEach((t) => {
    attach(llmCall(t))
    tools.push({
      localId: t.toolLocalId, parentLocalId: 1, name: TOOL_LABEL, kind: 'tool',
      startedAt: T0 + t.toolAt, endedAt: T0 + t.toolAt + t.toolMs, status: null, incomplete: false,
      toolStatus: 'ok', attribution: 'window',
    })
    for (const k of t.kids) attach(apiCall({ at: t.toolAt + k.at, ms: k.ms, endpoint: k.endpoint }))
  })

  const root: PendingTrace = {
    localId: 1, parentLocalId: null, name: ROOT_LABEL, kind: 'http-server',
    startedAt: T0, endedAt: T0 + 20_000, status: 200, incomplete: false,
  }

  w.write({ opened: [root, ...tools], closed: [] }, overrides.map((o) => baseRow(o)))
  const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id
  return { db, rootId, w }
}

describe('TraceView (tree-model)', () => {
  it('renders the reference trace: fold row, turn ordinals, ↺, guide glyphs', async () => {
    const { db, rootId } = seedReferenceLikeTrace()
    const { lastFrame } = render(
      <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
    await tick()
    const f = lastFrame()!
    expect(f).toContain('12× GET')
    expect(f).toContain('#1')
    expect(f).toContain('↺')
    expect(f).toContain('├')
    // LLM rows show the model, never the raw URL
    expect(f).not.toContain('/v1/messages')
  })

  it('⏎ on a fold expands in place; h collapses a tool; cursor is identity-keyed', async () => {
    const { db, rootId } = seedReferenceLikeTrace()

    // ⏎ on the fold expands it in place, revealing its members.
    {
      const { lastFrame, stdin } = render(
        <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
      await tick()
      expect(lastFrame()).not.toContain('MATERIAL_STOCK')
      stdin.write(DOWN); await tick()     // root -> fold
      stdin.write('\r'); await tick()     // expand in place
      expect(lastFrame()).toContain('MATERIAL_STOCK')
    }

    // h on an open tool collapses its children.
    {
      const { lastFrame, stdin } = render(
        <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
      await tick()
      stdin.write(DOWN); await tick()   // root -> fold
      stdin.write(DOWN); await tick()   // fold -> turn #1
      stdin.write(DOWN); await tick()   // turn #1 -> tool
      expect(lastFrame()).toContain('A_SalesOrder')
      stdin.write('h'); await tick()
      expect(lastFrame()).not.toContain('A_SalesOrder')
    }
  })

  it('cursor stays on its node when a new row is inserted above it (live append)', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tv-live-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/l', name: 'app', rootPath: '/l', gitRoot: null })
    const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })

    const api = (o: Partial<EnrichedRow> & { at: number }): Partial<EnrichedRow> => ({
      startedAt: T0 + o.at, latencyMs: 100, method: 'GET', hostname: 'x.example.com',
      entityClass: 'general', provider: null, model: null,
      tokensIn: null, tokensOut: null, tokensCached: null, costUsd: null, status: 200,
      ...o,
    })

    w.write({
      opened: [
        { localId: 1, parentLocalId: null, name: 'POST /api/x', kind: 'http-server',
          startedAt: T0, endedAt: T0 + 5000, status: 200, incomplete: false },
        { localId: 2, parentLocalId: 1, name: 'lookup_orders', kind: 'tool',
          startedAt: T0 + 100, endedAt: T0 + 1000, status: null, incomplete: false,
          toolStatus: 'ok', attribution: 'window' },
        { localId: 3, parentLocalId: 1, name: 'lookup_customers', kind: 'tool',
          startedAt: T0 + 2000, endedAt: T0 + 3000, status: null, incomplete: false,
          toolStatus: 'ok', attribution: 'window' },
      ],
      closed: [],
    }, [
      baseRow(api({ at: 150, normalizedEndpoint: '/orders-a', trace: { localId: 1, seq: 0 } })),
      baseRow(api({ at: 2100, normalizedEndpoint: '/customers-a', trace: { localId: 1, seq: 1 } })),
    ])
    const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id

    const { lastFrame, stdin } = render(
      <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
    await tick()
    // root -> lookup_orders -> its child -> lookup_customers
    stdin.write(DOWN); await tick()
    stdin.write(DOWN); await tick()
    stdin.write(DOWN); await tick()
    // Detail pane: the tool card is up, for THAT tool — the name renders twice,
    // once as the tree row and once as the card's title.
    expect(occurrences(lastFrame()!, 'lookup_customers')).toBe(2)

    // Append a second child to lookup_orders — a row that lands ABOVE
    // lookup_customers once the tree rebuilds, shifting every row below it
    // down by one. A positional cursor would now be pointing at that new
    // row; an identity-keyed one still finds lookup_customers.
    w.write({ opened: [], closed: [] },
      [baseRow(api({ at: 200, normalizedEndpoint: '/orders-b', trace: { localId: 1, seq: 2 } }))])
    await tick(1200)

    expect(lastFrame()).toContain('/orders-b')                 // the new row is there
    expect(occurrences(lastFrame()!, 'lookup_customers')).toBe(2)   // still on the same tool
  })

  it('f toggles flat mode and back', async () => {
    const { db, rootId } = seedReferenceLikeTrace()
    const { lastFrame, stdin } = render(
      <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
    await tick()
    expect(lastFrame()).toContain('12× GET')
    expect(lastFrame()).toContain(TOOL_LABEL)

    stdin.write('f'); await tick()
    // flat mode is per-call: no folding, no tool/trace rows, requests in
    // chronological order
    expect(lastFrame()).not.toContain('12× GET')
    expect(lastFrame()).not.toContain(TOOL_LABEL)
    expect(lastFrame()).toContain(MODEL)
    const f = lastFrame()!
    expect(f.indexOf('MATERIAL_STOCK')).toBeLessThan(f.indexOf(MODEL))   // seq order preserved

    stdin.write('f'); await tick()
    expect(lastFrame()).toContain('12× GET')
  })

  it('pruned trace renders the pruned message, not the expired one', async () => {
    const { db } = seedDb()
    const { lastFrame } = render(
      <TraceView db={db} traceId={777777} columns={140} onBack={noop} onOpenRequest={noop} />)
    await tick()
    expect(lastFrame()).toContain('no longer in the database')
  })

  // --- review round 1 -------------------------------------------------------

  it('⏎ re-collapses an open fold, and h on an open fold header collapses it in place (Finding 1)', async () => {
    const { db, rootId } = seedReferenceLikeTrace()
    const { lastFrame, stdin } = render(
      <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
    await tick()
    stdin.write(DOWN); await tick()     // root -> fold

    stdin.write('\r'); await tick()     // open
    expect(lastFrame()).toContain('▾')
    expect(lastFrame()).toContain('MATERIAL_STOCK')

    stdin.write('\r'); await tick()     // ⏎ again must re-collapse, not no-op
    expect(lastFrame()).toContain('▸')
    expect(lastFrame()).not.toContain('MATERIAL_STOCK')

    stdin.write('\r'); await tick()     // reopen
    expect(lastFrame()).toContain('MATERIAL_STOCK')
    stdin.write('h'); await tick()      // h on the OPEN header collapses it...
    expect(lastFrame()).toContain('▸')
    expect(lastFrame()).not.toContain('MATERIAL_STOCK')
    // ...and does not jump the cursor to root: another ⏎ still reopens the
    // same fold, proving the cursor stayed on the header.
    stdin.write('\r'); await tick()
    expect(lastFrame()).toContain('MATERIAL_STOCK')
  })

  it('follows to the new last row even when the old cursor key still exists (Finding 2)', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tv-follow-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/f', name: 'app', rootPath: '/f', gitRoot: null })
    const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })

    const api = (o: Partial<EnrichedRow> & { at: number }): Partial<EnrichedRow> => ({
      startedAt: T0 + o.at, latencyMs: 100, method: 'GET', hostname: 'x.example.com',
      entityClass: 'general', provider: null, model: null,
      tokensIn: null, tokensOut: null, tokensCached: null, status: 200,
      ...o,
    })

    w.write({
      opened: [{ localId: 1, parentLocalId: null, name: 'GET /x', kind: 'http-server',
        startedAt: T0, endedAt: T0 + 5000, status: 200, incomplete: false }],
      closed: [],
    }, [baseRow(api({
      at: 100, normalizedEndpoint: '/first-call', url: 'https://x.example.com/first-call',
      costUsd: null, trace: { localId: 1, seq: 0 },
    }))])
    const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id

    const { lastFrame, stdin } = render(
      <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
    await tick()
    stdin.write(DOWN); await tick()     // root -> first-call (the last row)
    expect(occurrences(lastFrame()!, '/first-call')).toBe(2)   // tree row + detail card

    // first-call's row (and key) is untouched by this append — it is not
    // removed, just no longer last. A naive identity-first resolver would
    // keep the cursor right where it is.
    w.write({ opened: [], closed: [] }, [baseRow(api({
      at: 2000, normalizedEndpoint: '/second-call', url: 'https://x.example.com/second-call',
      costUsd: 0.05, trace: { localId: 1, seq: 1 },
    }))])
    await tick(1200)

    expect(lastFrame()).toContain('/second-call')
    // selection followed to the new last row: its card is the one showing
    expect(occurrences(lastFrame()!, '/second-call')).toBe(2)
    expect(occurrences(lastFrame()!, '/first-call')).toBe(1)
  })

  it('clamps against the freshest cursor position, not a stale one from the last rows change (Finding 3)', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tv-fresh-')), 'burn0.db'))
    const projectId = ensureProject(db, { key: 'path:/s', name: 'app', rootPath: '/s', gitRoot: null })
    const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })

    const api = (o: Partial<EnrichedRow> & { at: number; endpoint: string }): Partial<EnrichedRow> => ({
      startedAt: T0 + o.at, latencyMs: 50, method: 'GET', hostname: 'x.example.com',
      normalizedEndpoint: `/orders/${o.endpoint}`,
      entityClass: 'general', provider: null, model: null,
      tokensIn: null, tokensOut: null, tokensCached: null, costUsd: null, status: 200,
      ...o,
    })

    w.write({
      opened: [{ localId: 1, parentLocalId: null, name: 'GET /x', kind: 'http-server',
        startedAt: T0, endedAt: T0 + 10_000, status: 200, incomplete: false }],
      closed: [],
    }, [
      baseRow(api({ at: 100, endpoint: 'a1', trace: { localId: 1, seq: 0 } })),
      baseRow(api({ at: 300, endpoint: 'a2', trace: { localId: 1, seq: 1 } })),
      baseRow(api({ at: 500, endpoint: 'a3', trace: { localId: 1, seq: 2 } })),
      baseRow({ ...llmCall({ at: 9000, ms: 200, tin: 10, cached: 0, tout: 5, cost: 0.001 }),
        trace: { localId: 1, seq: 3 } }),
    ])
    const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id

    const { lastFrame, stdin } = render(
      <TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
    await tick()
    // Pure cursor moves, no rows change in between — this is what must be
    // tracked continuously, not only when `rows` itself changes.
    stdin.write(DOWN); await tick()   // root -> a1
    stdin.write(DOWN); await tick()   // a1 -> a2
    stdin.write(DOWN); await tick()   // a2 -> a3
    expect(lastFrame()).toContain('/orders/a3')

    // A fourth same-shape sibling reaches FOLD_MIN — a1..a4 fold into one
    // row, and a3's individual row (and key) disappears from under the
    // cursor without ever being the last row.
    w.write({ opened: [], closed: [] },
      [baseRow(api({ at: 700, endpoint: 'a4', trace: { localId: 1, seq: 4 } }))])
    await tick(1200)

    expect(lastFrame()).not.toContain('/orders/a3')
    // Clamped near its old index (now the LLM turn, the new last row) —
    // not reset all the way back to root. The LLM card's exact token block is
    // the tell: the tree column renders `10→5` unspaced.
    expect(lastFrame()).toContain('tokens  10 → 5')
  })

  it('single-pane STEP width is columns - 34 per spec §2.5 (Finding 4)', () => {
    expect(computeLayout(140).stepWidth).toBe(53)          // two-pane regression
    expect(computeLayout(90).twoPane).toBe(false)
    expect(computeLayout(90).stepWidth).toBe(56)            // 90 - 34
  })
})
