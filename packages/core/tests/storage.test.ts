import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRun, insertRows, createWriter } from '../src/storage/db.js'
import { SCHEMA_VERSION, type EnrichedRow } from '../src/types.js'

export function fakeRow(over: Partial<EnrichedRow> = {}): EnrichedRow {
  return {
    startedAt: Date.now(), method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
    hostname: 'api.openai.com', status: 200, firstByteMs: 40, latencyMs: 300,
    reqBytes: 100, resBytes: 500, reqHeaders: { 'content-type': 'application/json' },
    resHeaders: { 'content-type': 'application/json' }, reqBody: '{"model":"gpt-4o"}',
    resBody: '{"usage":{"prompt_tokens":10,"completion_tokens":2}}', stackSnippet: 'at foo (app.js:1)',
    tags: { userId: 'u1' }, estimated: false, trace: null,
    entity: 'OpenAI', entityClass: 'llm', provider: 'openai',
    normalizedEndpoint: '/v1/chat/completions', model: 'gpt-4o',
    tokensIn: 10, tokensOut: 2, tokensCached: null, tokensCacheWrite: null, costUsd: 0.000045,
    reqTruncated: false, resTruncated: false,
    ...over,
  }
}

describe('storage', () => {
  const freshDb = () => openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-db-')), 'burn0.db'))

  it('creates db with schema and WAL', () => {
    const db = freshDb()
    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }])
    expect(db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get().value).toBe(String(SCHEMA_VERSION))
    db.close()
  })

  it('ensureProject is idempotent by key', () => {
    const db = freshDb()
    const a = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    const b = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    expect(a).toBe(b)
    db.close()
  })

  it('two repos with the same display name stay separate projects', () => {
    const db = freshDb()
    const a = ensureProject(db, { key: 'path:/code/alif', name: 'server', rootPath: '/code/alif', gitRoot: null })
    const b = ensureProject(db, { key: 'path:/code/beonai', name: 'server', rootPath: '/code/beonai', gitRoot: null })
    expect(a).not.toBe(b)
    db.close()
  })

  it('renaming package.json updates the label without forking the history', () => {
    const db = freshDb()
    const a = ensureProject(db, { key: 'path:/x', name: 'old-name', rootPath: '/x', gitRoot: null })
    const b = ensureProject(db, { key: 'path:/x', name: 'new-name', rootPath: '/x', gitRoot: null })
    expect(b).toBe(a)
    const row = db.prepare(`SELECT name, root_path FROM projects WHERE id = ?`).get(a)
    expect(row.name).toBe('new-name')
    // root_path is written once: two repos sharing a name-key would otherwise
    // flip-flop it on every process start
    expect(row.root_path).toBe('/x')
    db.close()
  })

  it('stores the service on each request row', () => {
    const db = freshDb()
    const pid = ensureProject(db, { key: 'path:/x', name: 'repo', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [fakeRow()], false, 'api')
    insertRows(db, pid, [fakeRow()], false)
    const services = db.prepare(`SELECT service FROM requests ORDER BY id`).all().map((r: any) => r.service)
    expect(services).toEqual(['api', null])
    db.close()
  })

  it('inserts request + payload rows', () => {
    const db = freshDb()
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [fakeRow()], true)
    const req = db.prepare('SELECT * FROM requests').get()
    expect(req.entity).toBe('OpenAI')
    expect(req.cost_usd).toBeCloseTo(0.000045, 10)
    expect(JSON.parse(req.tags)).toEqual({ userId: 'u1' })
    const pay = db.prepare('SELECT * FROM payloads WHERE request_id = ?').get(req.id)
    expect(pay.req_body).toBe('{"model":"gpt-4o"}')
    db.close()
  })

  it('skips payload rows when capturePayloads=false', () => {
    const db = freshDb()
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [fakeRow()], false)
    expect(db.prepare('SELECT COUNT(*) c FROM payloads').get().c).toBe(0)
    db.close()
  })

  it('stores tokens_cache_write on the request row', () => {
    const db = freshDb()
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [fakeRow({ tokensCacheWrite: 1024 })], false)
    expect(db.prepare(`SELECT tokens_cache_write FROM requests`).get().tokens_cache_write).toBe(1024)
    db.close()
  })

  it('defaults expired_calls to 0 on a trace inserted through createWriter', () => {
    const db = freshDb()
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    const runId = insertRun(db, { projectId: pid, service: null, pid: null, entry: null, nodeVersion: null })
    const w = createWriter(db, { projectId: pid, runId, service: null, capturePayloads: false })
    w.write({
      opened: [{
        localId: 1, parentLocalId: null, name: 'POST /api/chat', kind: 'http-server',
        startedAt: 1_000, endedAt: null, status: null, incomplete: false,
      }],
      closed: [],
    }, [])
    expect(db.prepare(`SELECT expired_calls FROM traces`).get().expired_calls).toBe(0)
    db.close()
  })

  it('renames db to .bak on schema version mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-db-'))
    const path = join(dir, 'burn0.db')
    const db1 = openDatabase(path)
    db1.prepare(`UPDATE meta SET value='999' WHERE key='schema_version'`).run()
    db1.close()
    const db2 = openDatabase(path)
    expect(existsSync(path + '.bak')).toBe(true)
    expect(db2.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get().value).toBe(String(SCHEMA_VERSION))
    db2.close()
  })
})
