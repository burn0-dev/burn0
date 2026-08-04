import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRun, createWriter, type StorageDriver } from '../src/storage/db.js'
import { traceTree } from '../src/query/index.js'
import { openTrace, closeTrace, drainTraces, resetTraces } from '../src/context/trace.js'
import { enrich } from '../src/capture/enrich.js'
import type { CaptureEvent } from '../src/types.js'
import { fakeRow } from './storage.test.js'

let db: StorageDriver
let projectId: number
let runId: number
const T0 = 1_700_000_000_000

const ENRICH_OPTS = {
  pricing: {}, bodyCapBytes: 1_048_576, redactDisabled: true, extraRedactHeaders: [], isSSE: false,
}

function event(over: Partial<CaptureEvent>): CaptureEvent {
  return {
    startedAt: T0, method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
    hostname: 'api.openai.com', status: 200, firstByteMs: 10, latencyMs: 100,
    reqBytes: 10, resBytes: 10, reqHeaders: {}, resHeaders: {},
    reqBody: null, resBody: null, stackSnippet: null, tags: null, estimated: false,
    trace: null, ...over,
  }
}

const declares = (tools: Array<{ id: string; name: string }>) => JSON.stringify({
  choices: [{ message: { tool_calls: tools.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: '{}' } })) } }],
})
const returns = (id: string, content: string) => JSON.stringify({
  messages: [{ role: 'tool', tool_call_id: id, content }],
})

beforeEach(() => {
  resetTraces()
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tool-')), 'burn0.db'))
  projectId = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  runId = insertRun(db, { projectId, service: null, pid: 1, entry: null, nodeVersion: null })
})

/** Drive a whole agent turn through enrich, the way capture would. */
function runTurn(opts: {
  tools: Array<{ id: string; name: string }>
  /** Calls the tool makes, as offsets from the declaring response's end. */
  inner?: Array<{ offsetMs: number; host: string; endpoint: string }>
  resultAt?: number
  resultBody?: string
}) {
  const root = openTrace('POST /api/chat', 'http-server', { now: T0 })
  let seq = 0
  const rows = []

  // 1. the LLM response that declares the tools (ends at T0 + 100)
  rows.push(enrich(event({
    startedAt: T0, latencyMs: 100, resBody: declares(opts.tools),
    trace: { localId: root.localId, seq: seq++ },
  }), ENRICH_OPTS))

  // 2. whatever the tool did while it ran
  for (const c of opts.inner ?? []) {
    rows.push(enrich(event({
      startedAt: T0 + 100 + c.offsetMs, latencyMs: 20,
      url: `https://${c.host}${c.endpoint}`, hostname: c.host,
      trace: { localId: root.localId, seq: seq++ },
    }), ENRICH_OPTS))
  }

  // 3. the follow-up request carrying the result — the closing bracket
  if (opts.resultAt != null) {
    rows.push(enrich(event({
      startedAt: opts.resultAt, latencyMs: 50,
      reqBody: opts.resultBody ?? returns(opts.tools[0].id, '{"status":"shipped"}'),
      trace: { localId: root.localId, seq: seq++ },
    }), ENRICH_OPTS))
  }

  closeTrace(root.localId, 200, T0 + 5000)
  createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    .write(drainTraces(), rows as any)
  return db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id as number
}

describe('tool calls', () => {
  it('records a declared tool as a node under the trace, with its arguments', () => {
    const rootId = runTurn({ tools: [{ id: 'call_a', name: 'search_orders' }], resultAt: T0 + 500 })
    const tool = db.prepare(`SELECT * FROM traces WHERE kind = 'tool'`).get()
    expect(tool.name).toBe('search_orders')
    expect(tool.tool_status).toBe('ok')
    expect(tool.attribution).toBe('window')
    expect(db.prepare(`SELECT args, result FROM tool_io WHERE trace_id = ?`).get(tool.id).result)
      .toBe('{"status":"shipped"}')
    expect(rootId).toBeGreaterThan(0)
  })

  it('surfaces a failing tool rather than swallowing it', () => {
    // every HTTP call returned 200 and the trace still looks successful
    runTurn({
      tools: [{ id: 'call_a', name: 'search_orders' }],
      resultAt: T0 + 500,
      resultBody: returns('call_a', '{"error":"order not found"}'),
    })
    expect(db.prepare(`SELECT tool_status FROM traces WHERE kind = 'tool'`).get().tool_status).toBe('error')
  })

  it('marks a tool the agent never resolved', () => {
    runTurn({ tools: [{ id: 'call_a', name: 'search_orders' }] })   // no follow-up
    expect(db.prepare(`SELECT tool_status FROM traces WHERE kind = 'tool'`).get().tool_status).toBe('unresolved')
  })

  it('nests the HTTP calls a tool made underneath it', () => {
    const rootId = runTurn({
      tools: [{ id: 'call_a', name: 'search_orders' }],
      inner: [
        { offsetMs: 40, host: 'api.pinecone.io', endpoint: '/query' },
        { offsetMs: 120, host: 'api.stripe.com', endpoint: '/v1/customers' },
      ],
      resultAt: T0 + 500,
    })
    const { nodes } = traceTree(db, rootId)!
    const tool = nodes.find((n) => n.type === 'tool')!
    expect(tool.label).toBe('search_orders')
    // "search_orders costs X every time it runs" needs these two beneath it —
    // the number LangSmith structurally cannot produce
    const beneath = nodes.filter((n) => n.type === 'request' && n.depth > tool.depth)
    expect(beneath.map((n) => n.hostname)).toEqual(['api.pinecone.io', 'api.stripe.com'])
    expect(tool.calls).toBe(2)
  })

  it('leaves candidates at the turn level when several tools ran concurrently', () => {
    // parallel tool calls have overlapping windows: nothing can honestly say
    // which one caused a given HTTP call
    const rootId = runTurn({
      tools: [{ id: 'call_a', name: 'search_orders' }, { id: 'call_b', name: 'get_weather' }],
      inner: [{ offsetMs: 40, host: 'api.pinecone.io', endpoint: '/query' }],
      resultAt: T0 + 500,
    })
    const { nodes } = traceTree(db, rootId)!
    const tools = nodes.filter((n) => n.type === 'tool')
    expect(tools.map((t) => t.label).sort()).toEqual(['get_weather', 'search_orders'])
    expect(tools.every((t) => t.attribution === 'turn')).toBe(true)
    // the Pinecone call sits beside the tools, not under either of them
    const pinecone = nodes.find((n) => n.hostname === 'api.pinecone.io')!
    expect(pinecone.depth).toBe(tools[0].depth)
  })

  it('shows a tool that did only local work as a leaf, not as an error', () => {
    const rootId = runTurn({ tools: [{ id: 'call_a', name: 'add_numbers' }], resultAt: T0 + 500 })
    const { nodes } = traceTree(db, rootId)!
    const tool = nodes.find((n) => n.type === 'tool')!
    expect(tool.calls).toBe(0)
    expect(tool.toolStatus).toBe('ok')
  })

  it('does not steal calls that happened outside every tool window', () => {
    const rootId = runTurn({
      tools: [{ id: 'call_a', name: 'search_orders' }],
      inner: [{ offsetMs: 40, host: 'api.pinecone.io', endpoint: '/query' }],
      resultAt: T0 + 300,
    })
    // a call after the result came back belongs to the turn, not the tool
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    const traceId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id
    db.prepare(`INSERT INTO requests
      (project_id, run_id, trace_id, seq, entity, entity_class, provider, method, url,
       normalized_endpoint, hostname, status, started_at, latency_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(projectId, runId, traceId, 99, 'Late', 'general', null, 'GET',
        'https://api.late.com/x', '/x', 'api.late.com', 200, T0 + 4000, 5)
    expect(w).toBeDefined()

    const { nodes } = traceTree(db, rootId)!
    const tool = nodes.find((n) => n.type === 'tool')!
    const late = nodes.find((n) => n.hostname === 'api.late.com')!
    expect(late.depth).toBe(tool.depth)     // sibling of the tool, not a child
  })
})
