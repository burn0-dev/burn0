import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openDatabase, ensureProject, insertRun, createWriter, query, type StorageDriver,
} from '@burn0/core'
import type { PendingTrace, EnrichedRow, TraceTreeNode } from '@burn0/core'
import { baseRow } from './helpers/seed.js'
import { buildRows, type DisplayRow } from '../src/tui/tree-model.js'
import { TraceDetail, fitSections, buildStrip } from '../src/tui/screens/TraceDetail.js'

// A minute ago: recent enough that a missing payload means "never captured",
// not "expired" — the two states the pane must never confuse.
const T0 = Date.now() - 120_000
const DAY = 86_400_000

const SAP_HOST = 'my-tenant.s4hanacloud.sap.com'
const LLM_HOST = 'api.anthropic.com'
const SAP_PREFIX = '/s4hanacloud/sap/opu/odata/sap/'
const ROOT_LABEL = 'POST /api/conversations/:id/chat'
const MODEL = 'claude-sonnet-5'
const TOOL_LABEL = 'sap_execute_sap_operation'
const RETENTION = { payloads: 7, metadata: 30 }

const DISCOVERY = [
  'API_SALES_ORDER_SRV/$metadata', 'API_BUSINESS_PARTNER/$metadata',
  'API_PRODUCT_SRV/$metadata', 'API_MATERIAL_STOCK_SRV/$metadata',
  'API_PURCHASEORDER_PROCESS_SRV/$metadata', 'API_SUPPLIER_INVOICE_SRV/$metadata',
  'API_BILLING_DOCUMENT_SRV/$metadata', 'API_OUTBOUND_DELIVERY_SRV/$metadata',
  'API_CUSTOMER_RETURN_SRV/$metadata', 'API_JOURNALENTRYITEMBASIC_SRV/$metadata',
  'API_COSTCENTER_SRV/$metadata', 'API_OPLACCTGDOCITEMCUBE_SRV/$metadata',
]

// ---------------------------------------------------------------------------
// Payload fixtures — a real Anthropic exchange: top-level system, 14 messages
// (12 of which the card must summarise rather than print), one tool_result
// carrier, one text + tool_use response.
// ---------------------------------------------------------------------------

const SYSTEM_TEXT = `You are an SAP operations assistant.\n${'Follow the tool contract exactly. '.repeat(41)}`
const TOOL_RESULT_TEXT = 'x'.repeat(8499)            // fmtBytes -> 8.3 KB
const USER_TEXT = 'how many sales orders did we book last week?'
const ASSISTANT_TEXT = 'I found 42 sales orders booked between Monday and Sunday.'

function llmReqBody(): string {
  const messages: any[] = []
  for (let i = 0; i < 11; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `filler turn ${i}` })
  }
  messages.push({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_1', name: TOOL_LABEL, input: { entity: 'A_SalesOrder' } }],
  })
  messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: TOOL_RESULT_TEXT }],
  })
  messages.push({ role: 'user', content: USER_TEXT })
  return JSON.stringify({ model: MODEL, system: SYSTEM_TEXT, messages })
}

function llmResBody(): string {
  return JSON.stringify({
    content: [
      { type: 'text', text: ASSISTANT_TEXT },
      { type: 'tool_use', id: 'tu_2', name: TOOL_LABEL, input: { entity: 'A_SalesOrder', top: 42 } },
    ],
  })
}

const TOOL_ARGS = JSON.stringify({ entity: 'A_SalesOrder', filter: "CreationDate ge datetime'2026-01-01'" })
const TOOL_RESULT = JSON.stringify({ count: 42, currency: 'EUR' })

// ---------------------------------------------------------------------------
// Trace fixture
// ---------------------------------------------------------------------------

const QUERY_URL =
  `https://${SAP_HOST}${SAP_PREFIX}API_SALES_ORDER_SRV/A_SalesOrder`
  + `?%24filter=CreationDate%20ge%20datetime'2026-01-01'&key=sk-abcdefghijklmnopqrs`

interface SeedOpts {
  capturePayloads?: boolean
  /** Shifts every timestamp back by this many days (payload-expiry states). */
  ageDays?: number
  llmReq?: string | null
  llmRes?: string | null
  /** Drop the failing/unresolved members so the root card reads clean. */
  clean?: boolean
  expiredCalls?: number
  tokens?: { tin: number | null; cached: number | null; write: number | null; tout: number | null; cost: number | null }
}

function seedTrace(o: SeedOpts = {}) {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-td-')), 'burn0.db'))
  const projectId = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  const runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
  const w = createWriter(db, { projectId, runId, service: null, capturePayloads: o.capturePayloads !== false })
  const base = T0 - (o.ageDays ?? 0) * DAY
  const tk = o.tokens ?? { tin: 46_802, cached: 46_800, write: 0, tout: 846, cost: 0.0203 }

  const rows: Partial<EnrichedRow>[] = []
  let seq = 0
  const at = (ms: number) => base + ms
  const api = (u: {
    ms: number; dur: number; endpoint: string; method?: string; status?: number | null; url?: string
  }): Partial<EnrichedRow> => ({
    trace: { localId: 1, seq: seq++ },
    startedAt: at(u.ms), latencyMs: u.dur, firstByteMs: 80, method: u.method ?? 'GET',
    hostname: SAP_HOST, normalizedEndpoint: SAP_PREFIX + u.endpoint,
    url: u.url ?? `https://${SAP_HOST}${SAP_PREFIX}${u.endpoint}`,
    entity: 'sap.com', entityClass: 'general', provider: null, model: null,
    tokensIn: null, tokensOut: null, tokensCached: null, tokensCacheWrite: null, costUsd: null,
    status: u.status === undefined ? 200 : u.status,
    reqBytes: 512, resBytes: 4096,
    reqBody: '{"probe":true}', resBody: '{"d":{"results":[{"SalesOrder":"4711"}]}}',
    stackSnippet: 'at sapClient.exec (sap-client.js:88)',
  })

  DISCOVERY.forEach((endpoint, i) => {
    rows.push(api({ ms: i * 175, dur: i === 11 ? 175 : 170, endpoint }))
  })

  rows.push({
    trace: { localId: 1, seq: seq++ },
    startedAt: at(2100), latencyMs: 5600, firstByteMs: 240, method: 'POST',
    hostname: LLM_HOST, normalizedEndpoint: '/v1/messages', url: `https://${LLM_HOST}/v1/messages`,
    entity: 'Anthropic', entityClass: 'llm', provider: 'anthropic', model: MODEL,
    tokensIn: tk.tin, tokensOut: tk.tout, tokensCached: tk.cached, tokensCacheWrite: tk.write,
    costUsd: tk.cost, status: 200, reqBytes: 48_000, resBytes: 2400,
    reqBody: o.llmReq === undefined ? llmReqBody() : o.llmReq,
    resBody: o.llmRes === undefined ? llmResBody() : o.llmRes,
    stackSnippet: 'at agentLoop (agent.js:42)',
  })

  rows.push(api({ ms: 7750, dur: 620, endpoint: 'API_SALES_ORDER_SRV/A_SalesOrder', url: QUERY_URL }))
  rows.push(api({
    ms: 8500, dur: 180, endpoint: 'API_SALES_ORDER_SRV/A_SalesOrder/$count',
    method: o.clean ? 'GET' : 'POST', status: o.clean ? 200 : 400,
  }))
  if (!o.clean) rows.push(api({ ms: 43_000, dur: 900, endpoint: 'API_PRODUCT_SRV/A_Product', status: null }))

  const tools: PendingTrace[] = [{
    localId: 2, parentLocalId: 1, name: TOOL_LABEL, kind: 'tool',
    startedAt: at(7700), endedAt: at(9100), status: null, incomplete: false,
    toolStatus: 'ok', attribution: 'window', args: TOOL_ARGS,
  }]
  if (!o.clean) {
    tools.push({
      localId: 3, parentLocalId: 1, name: 'sap_lookup_more', kind: 'tool',
      startedAt: at(39_800), endedAt: at(42_900), status: null, incomplete: false,
      toolStatus: 'unresolved', attribution: 'window',
    })
  }

  const root: PendingTrace = {
    localId: 1, parentLocalId: null, name: ROOT_LABEL, kind: 'http-server',
    startedAt: base, endedAt: at(48_300), status: 200, incomplete: false,
  }

  w.write({ opened: [root, ...tools], closed: [] }, rows.map((r) => baseRow(r)))
  w.write({
    opened: [],
    closed: [{
      localId: 2, parentLocalId: 1, name: TOOL_LABEL, kind: 'tool',
      startedAt: at(7700), endedAt: at(9100), status: null, incomplete: false,
      toolStatus: 'ok', attribution: 'window', args: TOOL_ARGS, result: TOOL_RESULT,
    }],
  }, [])

  const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id as number
  if (o.expiredCalls) db.prepare(`UPDATE traces SET expired_calls = ? WHERE id = ?`).run(o.expiredCalls, rootId)
  return { db, rootId }
}

function viewOf(db: StorageDriver, rootId: number, stepWidth = 40) {
  const tree = query.traceTree(db, rootId)!
  const rows = buildRows({
    tree, expanded: new Set(), collapsed: new Set(), stepWidth, flat: false,
  })
  return { rows, nodes: tree.nodes }
}

function frame(
  row: DisplayRow | undefined, db: StorageDriver, nodes: TraceTreeNode[],
  width = 60, height = 40,
): string {
  const { lastFrame } = render(
    <TraceDetail row={row} nodes={nodes} db={db} width={width} height={height} retention={RETENTION} />)
  return lastFrame()!
}

const llmRow = (rows: DisplayRow[]) => rows.find((r) => r.node?.model === MODEL)
const toolRow = (rows: DisplayRow[], label = TOOL_LABEL) =>
  rows.find((r) => r.node?.type === 'tool' && r.node.label === label)
const apiRow = (rows: DisplayRow[], needle: string) =>
  rows.find((r) => r.node?.type === 'request' && !r.node.llm && r.node.label.includes(needle))
const foldRow = (rows: DisplayRow[]) => rows.find((r) => r.kind === 'fold')

// ---------------------------------------------------------------------------

describe('TraceDetail — LLM card', () => {
  for (const width of [36, 60]) {
    it(`renders the exchange chat-style at width ${width}`, () => {
      const { db, rootId } = seedTrace()
      const { rows, nodes } = viewOf(db, rootId)
      const f = frame(llmRow(rows), db, nodes, width)

      expect(f).toContain(MODEL)
      // token block (spec §1.3) — omit-null, show-known-zero, floored percent
      expect(f).toContain('tokens  46,802 → 846')
      expect(f).toContain('fresh')
      expect(f).toContain('cached')
      expect(f).toContain('written')
      expect(f).toContain('(99%)')
      // conversation
      expect(f).toContain('12 earlier messages')
      expect(f).toContain('USER')
      expect(f).toContain('TOOL RESULT')
      expect(f).toContain('8.3 KB')
      expect(f).toContain('ASSISTANT')
      expect(f).toContain(`→ ${TOOL_LABEL}(`)
      expect(f).toContain('⏎ full payload')
      // the raw SSE/JSON is never dumped into the pane
      expect(f).not.toContain('tool_use_id')
    })
  }

  it('drops `first byte` then the start time below the narrow threshold', () => {
    const { db, rootId } = seedTrace()
    const { rows, nodes } = viewOf(db, rootId)

    const wide = frame(llmRow(rows), db, nodes, 60)
    expect(wide).toContain('first byte 240ms')
    expect(wide).toMatch(/\d\d:\d\d:\d\d/)

    const narrow = frame(llmRow(rows), db, nodes, 36)
    expect(narrow).not.toContain('first byte')
    expect(narrow).not.toMatch(/\d\d:\d\d:\d\d/)
    // never droppable
    expect(narrow).toContain('200')
    expect(narrow).toContain('5.6s')
    expect(narrow).toContain('$0.0203')
    expect(narrow).toContain('46,802 → 846')
  })

  it('never colors the duration — red is failure only (spec §2.4)', () => {
    const segs = buildStrip({
      lead: { text: '200' }, durationMs: 5600, firstByteMs: 240, startedAt: T0, inner: 56,
    })
    const dur = segs.find((s) => s.text === '5.6s')
    expect(dur).toBeDefined()
    expect(dur!.color).toBeUndefined()
  })

  it('shrinks in the spec order on a short terminal, keeping USER and ASSISTANT', () => {
    const { db, rootId } = seedTrace()
    const { rows, nodes } = viewOf(db, rootId)
    const f = frame(llmRow(rows), db, nodes, 60, 14)
    expect(f).not.toContain('earlier messages')          // marker dropped
    expect(f).not.toContain('You are an SAP')            // system dropped first
    expect(f).toContain('USER')
    expect(f).toContain('ASSISTANT')
    expect(f).toContain('tokens  46,802 → 846')          // the strip never shrinks
  })

  it('omits null token lines and shows known zeros', () => {
    const { db, rootId } = seedTrace({
      tokens: { tin: 46_802, cached: null, write: null, tout: 846, cost: 0.0203 },
    })
    const { rows, nodes } = viewOf(db, rootId)
    const f = frame(llmRow(rows), db, nodes)
    expect(f).toContain('tokens  46,802 → 846')
    expect(f).not.toContain('cached')
    expect(f).not.toContain('written')
  })

  it('flags partial usage on a costed request with one null token side', () => {
    const { db, rootId } = seedTrace({
      tokens: { tin: 46_802, cached: null, write: null, tout: null, cost: 0.0203 },
    })
    const { rows, nodes } = viewOf(db, rootId)
    expect(frame(llmRow(rows), db, nodes))
      .toContain('partial usage — true cost is at least this')
  })

  it('states an empty request side rather than showing an unexplained gap', () => {
    const { db, rootId } = seedTrace({ llmReq: '{"model":"claude-sonnet-5","messages":[]}' })
    const { rows, nodes } = viewOf(db, rootId)
    expect(frame(llmRow(rows), db, nodes)).toContain('no user message in this request')
  })

  it('states an empty response instead of rendering a blank card', () => {
    const { db, rootId } = seedTrace({ llmRes: '{"content":[]}' })
    const { rows, nodes } = viewOf(db, rootId)
    expect(frame(llmRow(rows), db, nodes)).toContain('no text and no tool calls in response')
  })

  it('falls back to a summary + two raw lines when the payload will not parse', () => {
    const { db, rootId } = seedTrace({ llmRes: '<html>\n502 Bad Gateway\nnginx\n</html>' })
    const { rows, nodes } = viewOf(db, rootId)
    const f = frame(llmRow(rows), db, nodes)
    expect(f).toContain('could not parse the stored payload')
    expect(f).toContain('502 Bad Gateway')
    expect(f).toContain('tokens  46,802 → 846')      // the summary card survives
  })

  it('extracts SSE rather than showing raw data: lines', () => {
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed answer"}}',
      'data: [DONE]', '',
    ].join('\n')
    const { db, rootId } = seedTrace({ llmRes: sse })
    const { rows, nodes } = viewOf(db, rootId)
    const f = frame(llmRow(rows), db, nodes)
    expect(f).toContain('streamed answer')
    expect(f).not.toContain('data:')
  })

  it('distinguishes an expired payload from one that was never captured', () => {
    {
      const { db, rootId } = seedTrace({ capturePayloads: false })
      const { rows, nodes } = viewOf(db, rootId)
      expect(frame(llmRow(rows), db, nodes)).toContain('capturePayloads: false')
    }
    {
      const { db, rootId } = seedTrace({ capturePayloads: false, ageDays: 10 })
      const { rows, nodes } = viewOf(db, rootId)
      const f = frame(llmRow(rows), db, nodes)
      expect(f).toContain('payload retention: 7 days')
      expect(f).toContain('structure and status remain for 30 days')
    }
  })
})

describe('TraceDetail — tool card', () => {
  for (const width of [36, 60]) {
    it(`renders status, attribution, rollup and I/O at width ${width}`, () => {
      const { db, rootId } = seedTrace()
      const { rows, nodes } = viewOf(db, rootId)
      const f = frame(toolRow(rows), db, nodes, width)
      expect(f).toContain(TOOL_LABEL)
      expect(f).toContain('attribution window (inferred)')
      expect(f).toContain('beneath it: 2 calls')
      expect(f).toContain('ARGS')
      expect(f).toContain('"entity": "A_SalesOrder"')     // pretty-printed
      expect(f).toContain('RESULT')
      expect(f).toContain('"count":42')            // RESULT renders as stored, not pretty
    })
  }

  it('says why an unresolved tool has no result', () => {
    const { db, rootId } = seedTrace()
    const { rows, nodes } = viewOf(db, rootId)
    const f = frame(toolRow(rows, 'sap_lookup_more'), db, nodes)
    expect(f).toContain('result never returned to the model')
    expect(f).toContain('window closed at trace end')
  })

  it('reports pruned tool_io as expiry, not as absence', () => {
    const { db, rootId } = seedTrace({ ageDays: 10 })
    db.prepare(`DELETE FROM tool_io`).run()
    const { rows, nodes } = viewOf(db, rootId)
    const f = frame(toolRow(rows), db, nodes)
    expect(f).toContain('args & result expired (payload retention: 7 days)')
    expect(f).toContain('structure and status remain for 30 days')
  })
})

describe('TraceDetail — API card', () => {
  for (const width of [36, 60]) {
    it(`renders the full endpoint, decoded query and response at width ${width}`, () => {
      const { db, rootId } = seedTrace()
      const { rows, nodes } = viewOf(db, rootId)
      const f = frame(apiRow(rows, 'A_SalesOrder'), db, nodes, width)
      expect(f).toContain('API_SALES_ORDER_SRV')
      expect(f).toContain('$filter=CreationDate')          // percent-decoded
      expect(f).toContain('key=[redacted]')                // secret-pattern redaction
      expect(f).not.toContain('sk-abcdefghijklmnopqrs')
      expect(f).toContain('RESPONSE')
      expect(f).toContain('called from')
      expect(f).toContain('⏎ full payload')
    })
  }

  it('names a null status as a network failure', () => {
    const { db, rootId } = seedTrace()
    const { rows, nodes } = viewOf(db, rootId)
    expect(frame(apiRow(rows, 'A_Product'), db, nodes)).toContain('no response — network failure')
  })
})

describe('TraceDetail — trace root card', () => {
  for (const width of [36, 60]) {
    it(`renders shape, pricing coverage, composition and issues at width ${width}`, () => {
      const { db, rootId } = seedTrace()
      const { rows, nodes } = viewOf(db, rootId)
      const f = frame(rows[0], db, nodes, width)
      expect(f).toContain(ROOT_LABEL.slice(0, 20))
      expect(f).toContain('steps')
      expect(f).toContain('1 of 16 calls priced')
      expect(f).toContain('tokens  46,802 → 846')
      expect(f).toContain(`1 LLM (${MODEL})`)
      expect(f).toContain('slowest')
      expect(f).toContain('costliest')
      expect(f).toContain('issues')
    })
  }

  it('omits the issues line entirely when the trace is clean', () => {
    const { db, rootId } = seedTrace({ clean: true })
    const { rows, nodes } = viewOf(db, rootId)
    expect(frame(rows[0], db, nodes)).not.toContain('issues')
  })

  it('caveats a partial sum when the sweep took calls', () => {
    const { db, rootId } = seedTrace({ expiredCalls: 9 })
    const { rows, nodes } = viewOf(db, rootId)
    expect(frame(rows[0], db, nodes)).toContain('(excludes 9 expired calls)')
  })
})

describe('TraceDetail — fold card', () => {
  for (const width of [36, 60]) {
    it(`summarises what the fold aggregates at width ${width}`, () => {
      const { db, rootId } = seedTrace()
      const { rows, nodes } = viewOf(db, rootId)
      const f = frame(foldRow(rows), db, nodes, width)
      expect(f).toContain('12× GET')
      expect(f).toContain('min 170ms')
      expect(f).toContain('median')
      expect(f).toContain('max 175ms')
      expect(f).toContain('all 2xx/3xx')
      expect(f).toContain('expands')
    })
  }
})

describe('fitSections', () => {
  const full = { marker: 1, system: 1, user: 3, results: 3, assistant: 8, tools: 4 }
  const total = (c: typeof full) => c.marker + c.system + c.user + c.results + c.assistant + c.tools

  it('is a no-op when everything fits', () => {
    expect(fitSections(full, 20)).toEqual(full)
  })

  it('applies the spec §3 shrink order one step at a time', () => {
    expect(fitSections(full, 19)).toEqual({ ...full, assistant: 4 })                       // assistant→4
    expect(fitSections(full, 15)).toEqual({ ...full, assistant: 4, user: 2 })              // user→2
    expect(fitSections(full, 14)).toEqual({ ...full, assistant: 4, user: 2, system: 0 })   // drop system
    expect(fitSections(full, 13))
      .toEqual({ ...full, assistant: 4, user: 2, system: 0, results: 1 })                  // results→1
    expect(fitSections(full, 11))
      .toEqual({ ...full, assistant: 4, user: 2, system: 0, results: 1, tools: 2 })        // tools→2
    expect(fitSections(full, 9))
      .toEqual({ marker: 0, system: 0, user: 2, results: 1, assistant: 4, tools: 2 })      // drop marker
    expect(fitSections(full, 8))
      .toEqual({ marker: 0, system: 0, user: 2, results: 1, assistant: 2, tools: 2 })      // assistant→2
    expect(fitSections(full, 6))
      .toEqual({ marker: 0, system: 0, user: 1, results: 1, assistant: 2, tools: 2 })      // user→1
  })

  it('never exceeds the budget, even past the end of the spec order', () => {
    for (let budget = 0; budget <= 20; budget++) {
      expect(total(fitSections(full, budget))).toBeLessThanOrEqual(Math.max(budget, 0))
    }
  })

  it('never grows a section above the caps it was handed', () => {
    const small = { marker: 0, system: 0, user: 1, results: 0, assistant: 1, tools: 0 }
    expect(fitSections(small, 40)).toEqual(small)
  })
})

