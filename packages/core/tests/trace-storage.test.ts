import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRun, createWriter, type StorageDriver } from '../src/storage/db.js'
import type { PendingTrace } from '../src/context/trace.js'
import { fakeRow } from './storage.test.js'

let db: StorageDriver
let projectId: number
let runId: number

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tr-')), 'burn0.db'))
  projectId = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  runId = insertRun(db, { projectId, service: 'api', pid: 123, entry: 'server.js', nodeVersion: 'v22.12.0' })
})

function trace(over: Partial<PendingTrace> & { localId: number }): PendingTrace {
  return {
    parentLocalId: null, name: 'POST /api/chat', kind: 'http-server',
    startedAt: 1_000, endedAt: null, status: null, incomplete: false, ...over,
  }
}

describe('run rows', () => {
  it('records the process that produced the traffic', () => {
    const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId)
    expect(row.project_id).toBe(projectId)
    expect(row.service).toBe('api')
    expect(row.pid).toBe(123)
    expect(row.entry).toBe('server.js')
    expect(row.node_version).toBe('v22.12.0')
    expect(row.ended_at).toBeNull()
  })
})

describe('writer', () => {
  it('inserts traces before the requests that reference them, in one flush', () => {
    const w = createWriter(db, { projectId, runId, service: 'api', capturePayloads: false })
    w.write({ opened: [trace({ localId: 1 })], closed: [] }, [
      fakeRow({ trace: { localId: 1, seq: 0 } }),
      fakeRow({ trace: { localId: 1, seq: 1 } }),
    ])
    const t = db.prepare(`SELECT * FROM traces`).get()
    expect(t.name).toBe('POST /api/chat')
    expect(t.run_id).toBe(runId)
    expect(t.project_id).toBe(projectId)
    const reqs = db.prepare(`SELECT trace_id, seq, run_id FROM requests ORDER BY seq`).all()
    expect(reqs.map((r: any) => r.trace_id)).toEqual([t.id, t.id])
    expect(reqs.map((r: any) => r.seq)).toEqual([0, 1])
    expect(reqs.every((r: any) => r.run_id === runId)).toBe(true)
  })

  it('resolves a trace opened in an earlier flush', () => {
    // requests routinely flush before their trace closes, and sometimes in a
    // later batch than the one that opened it
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    w.write({ opened: [trace({ localId: 7 })], closed: [] }, [])
    w.write({ opened: [], closed: [] }, [fakeRow({ trace: { localId: 7, seq: 0 } })])
    const t = db.prepare(`SELECT id FROM traces`).get()
    expect(db.prepare(`SELECT trace_id FROM requests`).get().trace_id).toBe(t.id)
  })

  it('updates the same row when the trace closes later', () => {
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    w.write({ opened: [trace({ localId: 1 })], closed: [] }, [])
    const before = db.prepare(`SELECT id, ended_at, status FROM traces`).get()
    expect(before.ended_at).toBeNull()

    w.write({ opened: [], closed: [trace({ localId: 1, endedAt: 2_500, status: 200 })] }, [])
    const rows = db.prepare(`SELECT id, ended_at, status, incomplete FROM traces`).all()
    expect(rows).toHaveLength(1)                 // updated, not forked
    expect(rows[0].id).toBe(before.id)
    expect(rows[0].ended_at).toBe(2_500)
    expect(rows[0].status).toBe(200)
    expect(rows[0].incomplete).toBe(0)
  })

  it('marks a swept trace as incomplete rather than pretending it finished', () => {
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    w.write({ opened: [trace({ localId: 1 })], closed: [] }, [])
    w.write({ opened: [], closed: [trace({ localId: 1, endedAt: 9_000, incomplete: true })] }, [])
    const row = db.prepare(`SELECT status, incomplete FROM traces`).get()
    expect(row.incomplete).toBe(1)
    expect(row.status).toBeNull()
  })

  it('links a nested trace to its parent', () => {
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    w.write({
      opened: [
        trace({ localId: 1 }),
        trace({ localId: 2, parentLocalId: 1, name: 'retrieve-context', kind: 'explicit' }),
      ],
      closed: [],
    }, [])
    const rows = db.prepare(`SELECT id, name, parent_id FROM traces ORDER BY id`).all()
    expect(rows[1].name).toBe('retrieve-context')
    expect(rows[1].parent_id).toBe(rows[0].id)
  })

  it('writes untraced requests with a run but no trace — never orphaned', () => {
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    w.write({ opened: [], closed: [] }, [fakeRow({ trace: null })])
    const r = db.prepare(`SELECT run_id, trace_id, seq FROM requests`).get()
    expect(r.run_id).toBe(runId)
    expect(r.trace_id).toBeNull()
    expect(r.seq).toBeNull()
  })

  it('drops a trace reference it cannot resolve rather than writing a dangling id', () => {
    const w = createWriter(db, { projectId, runId, service: null, capturePayloads: false })
    w.write({ opened: [], closed: [] }, [fakeRow({ trace: { localId: 999, seq: 3 } })])
    expect(db.prepare(`SELECT trace_id FROM requests`).get().trace_id).toBeNull()
  })
})
