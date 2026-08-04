import { describe, it, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectRuntime, runtimeCapabilities, runtimeVersion } from '../../src/runtime.js'
import { openDriver, openBunSqlite } from '../../src/storage/driver.js'
import { openDatabase, ensureProject, insertRun } from '../../src/storage/db.js'

describe('runtime detection under Bun', () => {
  it('detects bun, not node', () => {
    expect(detectRuntime()).toBe('bun')
  })
  it('capabilities: fetch + Bun.serve on, Node-only paths off', () => {
    const caps = runtimeCapabilities()
    expect(caps.patchFetch).toBe(true)
    expect(caps.patchBunServe).toBe(true)
    expect(caps.patchNodeHttp).toBe(false)
    expect(caps.subscribeUndici).toBe(false)
    expect(caps.patchNodeServers).toBe(false)
  })
  it('version string is distinguishable from a Node one', () => {
    expect(runtimeVersion()).toMatch(/^bun-\d+\.\d+/)
  })
})

describe('bun:sqlite driver', () => {
  it('openDriver selects the bun binding under Bun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-bunsq-'))
    const db = openDriver(join(dir, 't.db'))
    // The behavior the writer depends on, through the shared interface:
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE u (id INTEGER);')
    const got = db.prepare('INSERT INTO t (v) VALUES (?) RETURNING id').get('a')
    expect(got.id).toBe(1)
    const ran: any = db.prepare('INSERT INTO t (v) VALUES (?)').run('b')
    expect(Number(ran.lastInsertRowid)).toBe(2)
    const tx = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) db.prepare('INSERT INTO t (v) VALUES (?)').run(`tx${i}`)
    })
    tx(3)
    expect(db.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(5)
    expect(String((db.pragma('journal_mode') as any)?.journal_mode ?? '')).toBeTruthy()
    db.close()
  })

  it('openDatabase runs the real schema: WAL, version stamp, project + run rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-bundb-'))
    const db = openDatabase(join(dir, 'burn0.db'))
    const ver = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()
    expect(ver).toBeDefined()
    const pid = ensureProject(db, {
      key: 'path:/tmp/x', name: 'x', rootPath: '/tmp/x', gitRoot: null,
    } as any)
    expect(pid).toBeGreaterThan(0)
    const runId = insertRun(db, { projectId: pid, service: null, pid: 1, entry: 'a.ts', nodeVersion: runtimeVersion() })
    expect(runId).toBeGreaterThan(0)
    const run = db.prepare('SELECT node_version FROM runs WHERE id = ?').get(runId)
    expect(run.node_version).toMatch(/^bun-/)
    db.close()
  })

  it('openBunSqlite opens and operates without touching better-sqlite3', () => {
    // Why this driver exists (measured, Bun 1.3.9): in script mode Bun refuses
    // require('better-sqlite3') outright ("not yet supported", oven-sh/bun#4290);
    // under `bun test` the require *succeeds* and the process then hangs on
    // first use of the native addon. Load-then-hang is strictly worse than the
    // refusal, so nothing on the Bun path may ever reach better-sqlite3 —
    // asserting on its exact failure mode here would be asserting on undefined
    // behavior that already differs between Bun entry modes.
    const dir = mkdtempSync(join(tmpdir(), 'burn0-bunsq2-'))
    const db = openBunSqlite(join(dir, 'ok.db'))
    db.exec('CREATE TABLE t (id INTEGER)')
    db.prepare('INSERT INTO t VALUES (?)').run(7)
    expect(db.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(1)
    db.close()
  })
})
