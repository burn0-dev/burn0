import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRun, createWriter, type StorageDriver } from '../src/storage/db.js'
import { traceList, traceTree } from '../src/query/index.js'
import type { PendingTrace } from '../src/context/trace.js'
import { fakeRow } from './storage.test.js'

let db: StorageDriver
let projectId: number
let runId: number
let now: number

const T0 = 1_700_000_000_000

function trace(over: Partial<PendingTrace> & { localId: number }): PendingTrace {
  return {
    parentLocalId: null, name: null, kind: 'http-server',
    startedAt: T0, endedAt: null, status: null, incomplete: false, ...over,
  }
}

const llm = (over = {}) => fakeRow({
  entityClass: 'llm', hostname: 'api.openai.com', model: 'gpt-4o',
  normalizedEndpoint: '/v1/chat/completions', tokensIn: 1204, tokensOut: 380, costUsd: 0.0142,
  latencyMs: 820, ...over,
})
const api = (over = {}) => fakeRow({
  entityClass: 'general', provider: null, model: null, hostname: 'api.pinecone.io',
  normalizedEndpoint: '/query', tokensIn: null, tokensOut: null, costUsd: null,
  latencyMs: 41, ...over,
})

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tq-')), 'burn0.db'))
  now = T0 + 60_000
  projectId = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  runId = insertRun(db, { projectId, service: null, pid: 1, entry: 'server.js', nodeVersion: 'v22' })
})

const writer = () => createWriter(db, { projectId, runId, service: null, capturePayloads: false })

describe('traceList', () => {
  it('rolls a trace up: cost, calls, tokens, duration and its step shape', () => {
    const w = writer()
    w.write({
      opened: [trace({ localId: 1, name: 'POST /api/chat', startedAt: T0 })],
      closed: [trace({ localId: 1, name: 'POST /api/chat', startedAt: T0, endedAt: T0 + 2100, status: 200 })],
    }, [
      llm({ startedAt: T0 + 10, trace: { localId: 1, seq: 0 } }),
      api({ startedAt: T0 + 900, trace: { localId: 1, seq: 1 } }),
      llm({ startedAt: T0 + 1000, trace: { localId: 1, seq: 2 }, costUsd: 0.017, tokensIn: 2802, tokensOut: 210 }),
      api({ startedAt: T0 + 2000, trace: { localId: 1, seq: 3 } }),
    ])

    const [row] = traceList(db, { now })
    expect(row.name).toBe('POST /api/chat')
    expect(row.calls).toBe(4)
    expect(row.costUsd).toBeCloseTo(0.0312, 6)
    expect(row.pricedCalls).toBe(2)
    expect(row.tokensIn).toBe(4006)
    expect(row.tokensOut).toBe(590)
    expect(row.durationMs).toBe(2100)
    expect(row.status).toBe(200)
    // ◆ LLM, ◇ API — the trace's shape, readable before opening it
    expect(row.steps).toBe('◆◇◆◇')
  })

  it('rolls nested traces up into their root', () => {
    const w = writer()
    w.write({
      opened: [
        trace({ localId: 1, name: 'POST /api/chat' }),
        trace({ localId: 2, parentLocalId: 1, name: 'retrieve', kind: 'explicit' }),
      ],
      closed: [],
    }, [
      api({ startedAt: T0 + 10, trace: { localId: 2, seq: 0 } }),
      llm({ startedAt: T0 + 20, trace: { localId: 2, seq: 1 } }),
      llm({ startedAt: T0 + 30, trace: { localId: 1, seq: 2 } }),
    ])

    const rows = traceList(db, { now })
    expect(rows).toHaveLength(1)                 // only roots are listed
    expect(rows[0].name).toBe('POST /api/chat')
    expect(rows[0].calls).toBe(3)                // including the nested trace's calls
    expect(rows[0].steps).toBe('◇◆◆')
  })

  it('renders an unpriced trace as a gap, not as free', () => {
    const w = writer()
    w.write({ opened: [trace({ localId: 1, name: 'GET /health' })], closed: [] },
      [api({ startedAt: T0, trace: { localId: 1, seq: 0 } })])
    const [row] = traceList(db, { now })
    expect(row.pricedCalls).toBe(0)
  })

  it('shows untraced LLM calls too, so nothing is hidden', () => {
    const w = writer()
    w.write({ opened: [trace({ localId: 1, name: 'POST /api/chat' })], closed: [] },
      [llm({ startedAt: T0 + 100, trace: { localId: 1, seq: 0 } })])
    // a Bedrock call from a script, with no inbound request to root against
    w.write({ opened: [], closed: [] }, [llm({ startedAt: T0 + 200, model: 'claude-opus-5', trace: null })])

    const rows = traceList(db, { now })
    expect(rows).toHaveLength(2)
    const orphan = rows.find((r) => r.id == null)!
    expect(orphan.name).toBe('claude-opus-5')    // labelled by model
    expect(orphan.calls).toBe(1)
    expect(orphan.steps).toBe('◆')
    expect(orphan.requestId).not.toBeNull()      // still openable
  })

  it('is newest first and pages with beforeStartedAt', () => {
    const w = writer()
    for (let i = 0; i < 5; i++) {
      w.write({ opened: [trace({ localId: i + 1, name: `t${i}`, startedAt: T0 + i * 1000 })], closed: [] },
        [api({ startedAt: T0 + i * 1000, trace: { localId: i + 1, seq: 0 } })])
    }
    const page1 = traceList(db, { now, limit: 2 })
    expect(page1.map((r) => r.name)).toEqual(['t4', 't3'])
    const page2 = traceList(db, { now, limit: 2, beforeStartedAt: page1[1].startedAt })
    expect(page2.map((r) => r.name)).toEqual(['t2', 't1'])
  })

  it('marks a trace the sweep force-closed', () => {
    const w = writer()
    w.write({ opened: [trace({ localId: 1, name: 'POST /stream' })], closed: [] },
      [llm({ startedAt: T0, trace: { localId: 1, seq: 0 } })])
    w.write({ opened: [], closed: [trace({ localId: 1, endedAt: T0 + 5000, incomplete: true })] }, [])
    const [row] = traceList(db, { now })
    expect(row.incomplete).toBe(true)
    expect(row.status).toBeNull()
  })

  it('scopes to a project', () => {
    const other = ensureProject(db, { key: 'path:/y', name: 'other', rootPath: '/y', gitRoot: null })
    const otherRun = insertRun(db, { projectId: other, service: null, pid: 2, entry: null, nodeVersion: null })
    writer().write({ opened: [trace({ localId: 1, name: 'mine' })], closed: [] },
      [api({ startedAt: T0, trace: { localId: 1, seq: 0 } })])
    createWriter(db, { projectId: other, runId: otherRun, service: null, capturePayloads: false })
      .write({ opened: [trace({ localId: 1, name: 'theirs' })], closed: [] },
        [api({ startedAt: T0, trace: { localId: 1, seq: 0 } })])

    expect(traceList(db, { now }).map((r) => r.name).sort()).toEqual(['mine', 'theirs'])
    expect(traceList(db, { now, scope: { projectIds: [projectId], services: null } }).map((r) => r.name))
      .toEqual(['mine'])
  })
})

describe('traceTree', () => {
  it('returns the subtree flattened in seq order, with depth for the renderer', () => {
    const w = writer()
    w.write({
      opened: [
        trace({ localId: 1, name: 'POST /api/chat', startedAt: T0 }),
        trace({ localId: 2, parentLocalId: 1, name: 'retrieve-context', kind: 'explicit', startedAt: T0 + 5 }),
        trace({ localId: 3, parentLocalId: 1, name: 'answer', kind: 'explicit', startedAt: T0 + 300 }),
      ],
      closed: [],
    }, [
      api({ startedAt: T0 + 10, trace: { localId: 2, seq: 0 } }),
      llm({ startedAt: T0 + 100, trace: { localId: 2, seq: 1 }, model: 'text-embedding-3' }),
      llm({ startedAt: T0 + 400, trace: { localId: 3, seq: 2 } }),
    ])
    const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id

    const nodes = traceTree(db, rootId)
    expect(nodes.map((n) => [n.depth, n.type, n.label])).toEqual([
      [0, 'trace', 'POST /api/chat'],
      [1, 'trace', 'retrieve-context'],
      [2, 'request', 'POST /query'],
      [2, 'request', 'POST /v1/chat/completions'],
      [1, 'trace', 'answer'],
      [2, 'request', 'POST /v1/chat/completions'],
    ])
    // request nodes carry what the detail pane needs
    const first = nodes.find((n) => n.type === 'request')!
    expect(first.requestId).not.toBeNull()
    expect(first.hostname).toBe('api.pinecone.io')
    expect(first.llm).toBe(false)
    expect(nodes.find((n) => n.model === 'text-embedding-3')!.llm).toBe(true)
  })

  it('rolls each trace node up over its own subtree', () => {
    const w = writer()
    w.write({
      opened: [
        trace({ localId: 1, name: 'root' }),
        trace({ localId: 2, parentLocalId: 1, name: 'child', kind: 'explicit' }),
      ],
      closed: [],
    }, [
      llm({ startedAt: T0 + 10, trace: { localId: 2, seq: 0 }, costUsd: 0.01 }),
      llm({ startedAt: T0 + 20, trace: { localId: 1, seq: 1 }, costUsd: 0.02 }),
    ])
    const rootId = db.prepare(`SELECT id FROM traces WHERE parent_id IS NULL`).get().id
    const nodes = traceTree(db, rootId)
    expect(nodes[0].costUsd).toBeCloseTo(0.03, 6)   // root: both calls
    expect(nodes[1].costUsd).toBeCloseTo(0.01, 6)   // child: only its own
    expect(nodes[0].calls).toBe(2)
    expect(nodes[1].calls).toBe(1)
  })

  it('renders a trace whose children were pruned as empty rather than erroring', () => {
    // retention prunes requests by started_at, so a trace can outlive its calls
    writer().write({ opened: [trace({ localId: 1, name: 'old' })], closed: [] }, [])
    const rootId = db.prepare(`SELECT id FROM traces`).get().id
    const nodes = traceTree(db, rootId)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].calls).toBe(0)
  })

  it('returns nothing for an unknown id instead of throwing', () => {
    expect(traceTree(db, 99999)).toEqual([])
  })
})
