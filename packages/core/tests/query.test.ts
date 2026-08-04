import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRows, type StorageDriver } from '../src/storage/db.js'
import { overview, entityList, traces, requestDetail, liveTail, todaySummary } from '../src/query/index.js'
import { fakeRow } from './storage.test.js'

const DAY = 86_400_000
let db: StorageDriver
let now: number

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-q-')), 'burn0.db'))
  now = Date.now()
  const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  insertRows(db, pid, [
    fakeRow({ startedAt: now - 1000, costUsd: 0.01 }),                                 // today, llm
    fakeRow({ startedAt: now - 2 * DAY, costUsd: 0.02, model: 'gpt-4o-mini' }),        // this month, llm
    fakeRow({
      startedAt: now - 1000, entity: 'Stripe', entityClass: 'general', provider: null,
      model: null, tokensIn: null, tokensOut: null, costUsd: null, status: 500,
      url: 'https://api.stripe.com/v1/charges', hostname: 'api.stripe.com',
      normalizedEndpoint: '/v1/charges',
    }),
  ], true)
})

describe('overview', () => {
  it('computes spend, calls, error rate, latency', () => {
    const o = overview(db, now)
    expect(o.llmSpend30d).toBeCloseTo(0.03, 10)
    expect(o.llmSpendToday).toBeCloseTo(0.01, 10)
    expect(o.totalCalls).toBe(3)
    expect(o.errorRate).toBeCloseTo(1 / 3, 5)
    expect(o.avgLatencyMs).toBeGreaterThan(0)
  })
})

describe('entityList', () => {
  it('llm entities first by cost, then general by calls', () => {
    const list = entityList(db, now)
    expect(list[0].entity).toBe('OpenAI')
    expect(list[0].costUsd).toBeCloseTo(0.03, 10)
    expect(list[1].entity).toBe('Stripe')
    expect(list[1].errorRate).toBe(1)
  })
})

describe('traces / requestDetail / liveTail', () => {
  it('llm traces exclude general rows', () => {
    const t = traces(db, { llm: true })
    expect(t.length).toBe(2)
    expect(t[0].project).toBe('app')
  })
  it('requestDetail returns payload with redacted-at-write bodies', () => {
    const t = traces(db, { llm: true })
    const d = requestDetail(db, t[0].id)
    expect(d).not.toBeNull()
    expect(d!.payload!.reqBody).toBe('{"model":"gpt-4o"}')
  })
  it('liveTail returns rows after id', () => {
    const all = traces(db, { llm: false, limit: 100 })
    expect(liveTail(db, 0).length).toBe(3)
    expect(liveTail(db, Math.max(...all.map((r) => r.id), ...traces(db, { llm: true }).map((r) => r.id))).length).toBe(0)
  })
})

describe('traces filters — the Logs stream', () => {
  it('llm: null returns LLM and API calls interleaved, newest first', () => {
    const t = traces(db, { llm: null, limit: 100 })
    expect(t.length).toBe(3)
    expect(new Set(t.map((r) => r.entity))).toEqual(new Set(['OpenAI', 'Stripe']))
    // ids descend — the stream is newest-first
    expect(t.map((r) => r.id)).toEqual([...t.map((r) => r.id)].sort((a, b) => b - a))
  })

  it('errorsOnly keeps 4xx/5xx and network failures (status NULL)', () => {
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [fakeRow({ startedAt: now - 500, status: null })], true)
    const t = traces(db, { llm: null, errorsOnly: true, limit: 100 })
    expect(t.length).toBe(2)
    expect(t.map((r) => r.status).sort()).toEqual([500, null])
  })

  it('carries hostname and byte volume, which the Logs stream renders per row', () => {
    const stripe = traces(db, { llm: null, limit: 100 }).find((r) => r.entity === 'Stripe')!
    expect(stripe.hostname).toBe('api.stripe.com')
    expect(stripe.reqBytes).toBe(100)
    expect(stripe.resBytes).toBe(500)
  })

  it('entity narrows to one vendor', () => {
    const t = traces(db, { llm: null, entity: 'Stripe', limit: 100 })
    expect(t.length).toBe(1)
    expect(t[0].entity).toBe('Stripe')
  })

  it('beforeId pages backwards through the tail', () => {
    const page1 = traces(db, { llm: null, limit: 2 })
    const page2 = traces(db, { llm: null, limit: 2, beforeId: page1[page1.length - 1].id })
    expect(page1.length).toBe(2)
    expect(page2.length).toBe(1)
    expect(page2[0].id).toBeLessThan(page1[1].id)
  })
})

describe('liveTail filters', () => {
  it('applies the same predicate as traces, so follow mode cannot leak filtered rows', () => {
    expect(liveTail(db, 0, { llm: true }).length).toBe(2)
    expect(liveTail(db, 0, { llm: null, entity: 'Stripe' }).length).toBe(1)
    expect(liveTail(db, 0, { llm: null, errorsOnly: true }).length).toBe(1)
  })
})

describe('todaySummary', () => {
  it('today only', () => {
    const s = todaySummary(db, now)
    expect(s.spendToday).toBeCloseTo(0.01, 10)
    expect(s.callsToday).toBe(2)
    expect(s.topModels[0].model).toBe('gpt-4o')
  })
})

describe('overview/entityList window', () => {
  it('windowDays filters range; 0 = today only', () => {
    const o30 = overview(db, now, 30)
    const oToday = overview(db, now, 0)
    expect(o30.totalCalls).toBe(3)
    expect(oToday.totalCalls).toBe(2)          // 2-day-old llm row excluded
    expect(oToday.llmSpend30d).toBeCloseTo(0.01, 10)
    expect(entityList(db, now, 0).find((e: any) => e.entity === 'OpenAI')!.calls).toBe(1)
  })
})
