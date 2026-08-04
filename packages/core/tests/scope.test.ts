import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRows, type StorageDriver } from '../src/storage/db.js'
import {
  overview, entityList, usageRows, usageTree, traces, liveTail,
  todaySummary, dbStats, exportRows, projects, servicesFor, type Scope,
} from '../src/query/index.js'
import { fakeRow } from './storage.test.js'

let db: StorageDriver
let now: number
let alif: number
let beonai: number

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-s-')), 'burn0.db'))
  now = Date.now()
  // Two different repos whose package.json both say "server" — the collision
  // that silently merged them before identity moved to `key`.
  alif = ensureProject(db, { key: 'path:/code/alif', name: 'server', rootPath: '/code/alif', gitRoot: '/code/alif' })
  beonai = ensureProject(db, { key: 'path:/code/beonai', name: 'server', rootPath: '/code/beonai', gitRoot: '/code/beonai' })

  insertRows(db, alif, [
    fakeRow({ startedAt: now - 1000, costUsd: 0.01 }),
    fakeRow({ startedAt: now - 900, costUsd: 0.02 }),
  ], true, 'api')
  insertRows(db, alif, [
    fakeRow({ startedAt: now - 800, costUsd: 0.04, hostname: 'api.anthropic.com', entity: 'Anthropic' }),
  ], true, 'worker')
  insertRows(db, beonai, [
    fakeRow({ startedAt: now - 700, costUsd: 0.08, hostname: 'api.stripe.com', entity: 'Stripe',
      entityClass: 'general', provider: null, model: null, tokensIn: null, tokensOut: null }),
  ], true)
})

const only = (id: number, services: string[] | null = null): Scope => ({ projectIds: [id], services })

describe('every read takes a scope', () => {
  it('overview counts one project, not the machine', () => {
    expect(overview(db, now, 30).totalCalls).toBe(4)
    expect(overview(db, now, 30, only(alif)).totalCalls).toBe(3)
    expect(overview(db, now, 30, only(beonai)).llmSpend30d).toBeCloseTo(0.08, 10)
  })

  it('entityList, usageRows and usageTree scope', () => {
    expect(entityList(db, now, 30, only(beonai)).map((e: any) => e.entity)).toEqual(['Stripe'])
    expect(usageRows(db, { now, scope: only(beonai) }).every((r) => r.hostname === 'api.stripe.com')).toBe(true)
    expect(usageTree(db, { now, scope: only(alif) }).map((n) => n.label).sort()).toEqual(['Anthropic', 'OpenAI'])
  })

  it('traces and liveTail scope', () => {
    expect(traces(db, { llm: null, limit: 100 }).length).toBe(4)
    expect(traces(db, { llm: null, limit: 100, scope: only(alif) }).length).toBe(3)
    expect(liveTail(db, 0, { llm: null, scope: only(beonai) }).length).toBe(1)
  })

  it('todaySummary and dbStats scope', () => {
    expect(todaySummary(db, now, only(alif)).callsToday).toBe(3)
    expect(dbStats(db, only(beonai)).requestCount).toBe(1)
    expect(dbStats(db).requestCount).toBe(4)
  })

  it('export dumps one project, not every project on the machine', () => {
    expect(exportRows(db).length).toBe(4)
    expect(exportRows(db, only(alif)).length).toBe(3)
  })

  it('services narrow within a project', () => {
    expect(overview(db, now, 30, only(alif, ['api'])).totalCalls).toBe(2)
    expect(overview(db, now, 30, only(alif, ['api', 'worker'])).totalCalls).toBe(3)
  })

  it('an empty project list matches nothing, not everything', () => {
    // "no project resolved" must not silently widen to the whole machine —
    // the fallback-to-all decision belongs to the caller, not the query
    expect(overview(db, now, 30, { projectIds: [], services: null }).totalCalls).toBe(0)
    expect(traces(db, { llm: null, scope: { projectIds: [], services: null } }).length).toBe(0)
  })
})

describe('projects listing', () => {
  it('reports each project with its path, services, call count and last seen', () => {
    const list = projects(db)
    expect(list.map((p) => p.name)).toEqual(['server', 'server'])
    const a = list.find((p) => p.rootPath === '/code/alif')!
    expect(a.id).toBe(alif)
    expect(a.calls).toBe(3)
    expect(a.services.sort()).toEqual(['api', 'worker'])
    expect(a.lastSeen).toBeGreaterThan(0)

    const b = list.find((p) => p.rootPath === '/code/beonai')!
    expect(b.calls).toBe(1)
    expect(b.services).toEqual([])   // single-package repo — no sub-dimension
  })

  it('servicesFor lists the distinct services inside a scope', () => {
    expect(servicesFor(db, only(alif)).sort()).toEqual(['api', 'worker'])
    expect(servicesFor(db, only(beonai))).toEqual([])
  })
})
