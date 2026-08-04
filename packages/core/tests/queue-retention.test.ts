import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteQueue } from '../src/storage/queue.js'
import { pruneRetention } from '../src/storage/retention.js'
import { openDatabase, ensureProject, insertRows, insertRun, createWriter } from '../src/storage/db.js'
import { fakeRow } from './storage.test.js'

describe('WriteQueue', () => {
  it('flushes on maxBatch immediately', () => {
    const flushed: any[] = []
    const q = new WriteQueue({ flush: (rows) => flushed.push(...rows), maxBatch: 3, intervalMs: 10000 })
    for (let i = 0; i < 3; i++) q.push(fakeRow())
    expect(flushed.length).toBe(3)
    q.stop()
  })
  it('flushes on interval', async () => {
    vi.useFakeTimers()
    const flushed: any[] = []
    const q = new WriteQueue({ flush: (rows) => flushed.push(...rows), maxBatch: 100, intervalMs: 250 })
    q.push(fakeRow())
    vi.advanceTimersByTime(300)
    expect(flushed.length).toBe(1)
    q.stop()
    vi.useRealTimers()
  })
  it('drops oldest beyond maxPending and counts', () => {
    const q = new WriteQueue({ flush: () => { throw new Error('db down') }, maxBatch: 10, intervalMs: 10000, maxPending: 5 })
    for (let i = 0; i < 20; i++) q.push(fakeRow())
    expect(q.dropped).toBeGreaterThan(0)
    q.stop()
  })
  it('never throws when flush fn throws', () => {
    const q = new WriteQueue({ flush: () => { throw new Error('boom') }, maxBatch: 1, intervalMs: 10000 })
    expect(() => q.push(fakeRow())).not.toThrow()
    q.stop()
  })
})

describe('pruneRetention', () => {
  it('deletes old payloads at 7d and old requests at 30d', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-ret-')), 'burn0.db'))
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    const now = Date.now()
    const day = 86_400_000
    insertRows(db, pid, [
      fakeRow({ startedAt: now - 1 * day }),   // keep both
      fakeRow({ startedAt: now - 10 * day }),  // payload pruned, request kept
      fakeRow({ startedAt: now - 40 * day }),  // both pruned
    ], true)
    pruneRetention(db, { payloads: 7, metadata: 30 }, now)
    expect(db.prepare('SELECT COUNT(*) c FROM requests').get().c).toBe(2)
    expect(db.prepare('SELECT COUNT(*) c FROM payloads').get().c).toBe(1)
    db.close()
  })

  it('prunes traces, tool io and runs alongside the requests they held', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-ret3-')), 'burn0.db'))
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    const now = Date.now()
    const day = 86_400_000
    const oldRun = insertRun(db, { projectId: pid, service: null, pid: 1, entry: null, nodeVersion: null, now: now - 40 * day })
    const newRun = insertRun(db, { projectId: pid, service: null, pid: 2, entry: null, nodeVersion: null, now: now - 1 * day })
    const w = createWriter(db, { projectId: pid, runId: oldRun, service: null, capturePayloads: false })
    w.write({
      opened: [{ localId: 1, parentLocalId: null, name: 'old', kind: 'http-server', startedAt: now - 40 * day, endedAt: null, status: null, incomplete: false }],
      closed: [],
    }, [])
    const oldTraceId = db.prepare(`SELECT id FROM traces`).get().id
    db.prepare(`INSERT INTO tool_io (trace_id, args, result) VALUES (?, ?, ?)`).run(oldTraceId, '{}', '{}')

    createWriter(db, { projectId: pid, runId: newRun, service: null, capturePayloads: false }).write({
      opened: [{ localId: 9, parentLocalId: null, name: 'recent', kind: 'http-server', startedAt: now - 1 * day, endedAt: null, status: null, incomplete: false }],
      closed: [],
    }, [])

    pruneRetention(db, { payloads: 7, metadata: 30 }, now, pid)

    expect(db.prepare(`SELECT COUNT(*) c FROM traces`).get().c).toBe(1)
    expect(db.prepare(`SELECT name FROM traces`).get().name).toBe('recent')
    expect(db.prepare(`SELECT COUNT(*) c FROM tool_io`).get().c).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) c FROM runs`).get().c).toBe(1)
    db.close()
  })

  it("increments a trace's expired_calls by the requests it loses in the sweep", () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-ret4-')), 'burn0.db'))
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    const now = Date.now()
    const day = 86_400_000
    const runId = insertRun(db, { projectId: pid, service: null, pid: 1, entry: null, nodeVersion: null, now })
    const w = createWriter(db, { projectId: pid, runId, service: null, capturePayloads: false })
    w.write({
      opened: [{
        localId: 1, parentLocalId: null, name: 'trace', kind: 'http-server',
        startedAt: now - 1 * day, endedAt: null, status: null, incomplete: false,
      }],
      closed: [],
    }, [
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 1, seq: 1 } }),
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 1, seq: 2 } }),
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 1, seq: 3 } }),
      fakeRow({ startedAt: now - 1 * day, trace: { localId: 1, seq: 4 } }),
      fakeRow({ startedAt: now - 1 * day, trace: { localId: 1, seq: 5 } }),
    ])

    pruneRetention(db, { payloads: 7, metadata: 30 }, now, pid)

    const trace = db.prepare(`SELECT expired_calls FROM traces WHERE name = 'trace'`).get()
    expect(trace.expired_calls).toBe(3)
    expect(db.prepare('SELECT COUNT(*) c FROM requests').get().c).toBe(2)
    db.close()
  })

  it('still counts expired calls onto a trace that is itself pruned in the same pass, without orphaning', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-ret5-')), 'burn0.db'))
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    const now = Date.now()
    const day = 86_400_000
    const runId = insertRun(db, { projectId: pid, service: null, pid: 1, entry: null, nodeVersion: null, now })
    const w = createWriter(db, { projectId: pid, runId, service: null, capturePayloads: false })
    w.write({
      opened: [
        {
          localId: 1, parentLocalId: null, name: 'old-trace', kind: 'http-server',
          startedAt: now - 40 * day, endedAt: null, status: null, incomplete: false,
        },
        {
          localId: 2, parentLocalId: null, name: 'surviving-trace', kind: 'http-server',
          startedAt: now - 1 * day, endedAt: null, status: null, incomplete: false,
        },
      ],
      closed: [],
    }, [
      // old-trace: itself outside the retention window, so its own row is pruned too
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 1, seq: 1 } }),
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 1, seq: 2 } }),
      // surviving-trace: 3 old requests expire, 1 recent one stays
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 2, seq: 1 } }),
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 2, seq: 2 } }),
      fakeRow({ startedAt: now - 40 * day, trace: { localId: 2, seq: 3 } }),
      fakeRow({ startedAt: now - 1 * day, trace: { localId: 2, seq: 4 } }),
    ])

    expect(() => pruneRetention(db, { payloads: 7, metadata: 30 }, now, pid)).not.toThrow()

    // old-trace is gone — no orphaned trace row, no error from updating a row
    // that gets deleted moments later in the same pass
    expect(db.prepare(`SELECT COUNT(*) c FROM traces`).get().c).toBe(1)
    const surviving = db.prepare(`SELECT expired_calls FROM traces WHERE name = 'surviving-trace'`).get()
    expect(surviving.expired_calls).toBe(3)
    db.close()
  })

  it('prunes only the given project — one repo cannot expire another repo rows', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-ret2-')), 'burn0.db'))
    const mine = ensureProject(db, { key: 'path:/mine', name: 'mine', rootPath: '/mine', gitRoot: null })
    const theirs = ensureProject(db, { key: 'path:/theirs', name: 'theirs', rootPath: '/theirs', gitRoot: null })
    const now = Date.now()
    const day = 86_400_000
    insertRows(db, mine, [fakeRow({ startedAt: now - 40 * day })], true)
    insertRows(db, theirs, [fakeRow({ startedAt: now - 40 * day })], true)

    pruneRetention(db, { payloads: 7, metadata: 30 }, now, mine)

    const left = db.prepare('SELECT project_id FROM requests').all().map((r: any) => r.project_id)
    expect(left).toEqual([theirs])
    db.close()
  })
})
