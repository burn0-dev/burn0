import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRows, type StorageDriver } from '../src/storage/db.js'
import { usageRows, usageTree } from '../src/query/index.js'
import { fakeRow } from './storage.test.js'

let db: StorageDriver
let now: number

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-u-')), 'burn0.db'))
  now = Date.now()
  const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  insertRows(db, pid, [
    // same endpoint, different methods — POST sends mail and costs money, GET lists it
    fakeRow({
      startedAt: now - 1000, method: 'POST', entity: 'Resend', entityClass: 'general', provider: null,
      hostname: 'api.resend.com', normalizedEndpoint: '/emails', model: null,
      tokensIn: null, tokensOut: null, costUsd: null, reqBytes: 400, resBytes: 90,
    }),
    fakeRow({
      startedAt: now - 900, method: 'GET', entity: 'Resend', entityClass: 'general', provider: null,
      hostname: 'api.resend.com', normalizedEndpoint: '/emails', model: null,
      tokensIn: null, tokensOut: null, costUsd: null, reqBytes: 0, resBytes: 1200,
    }),
  ], true)
})

describe('usageRows', () => {
  it('keeps methods separate on the same endpoint', () => {
    const rows = usageRows(db, { now, windowDays: 30 })
    const emails = rows.filter((r) => r.endpoint === '/emails')
    expect(emails).toHaveLength(2)
    expect(emails.map((r) => r.method).sort()).toEqual(['GET', 'POST'])
  })

  it('reports how many calls carried a price, so unpriced is not shown as $0.00', () => {
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [
      fakeRow({ startedAt: now - 800, hostname: 'api.openai.com', normalizedEndpoint: '/v1/chat/completions', costUsd: 0.02 }),
      fakeRow({ startedAt: now - 700, hostname: 'api.openai.com', normalizedEndpoint: '/v1/chat/completions', costUsd: null }),
    ], true)
    const rows = usageRows(db, { now, windowDays: 30 })
    const chat = rows.find((r) => r.endpoint === '/v1/chat/completions')!
    expect(chat.calls).toBe(2)
    expect(chat.pricedCalls).toBe(1)

    // a non-LLM endpoint has no priced calls at all — the UI must render '—', not '$0.00'
    const emails = rows.find((r) => r.endpoint === '/emails' && r.method === 'POST')!
    expect(emails.pricedCalls).toBe(0)
  })

  it('reports how many calls measured byte volume, so unknown is not shown as 0', () => {
    const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
    insertRows(db, pid, [
      // captured through the undici DC path: metadata only, no body observation
      fakeRow({ startedAt: now - 600, hostname: 'api.pinecone.io', normalizedEndpoint: '/query',
        entityClass: 'general', provider: null, model: null, costUsd: null,
        tokensIn: null, tokensOut: null,
        reqBytes: null as any, resBytes: null as any }),
      fakeRow({ startedAt: now - 500, hostname: 'api.pinecone.io', normalizedEndpoint: '/query',
        entityClass: 'general', provider: null, model: null, costUsd: null,
        tokensIn: null, tokensOut: null,
        reqBytes: 120, resBytes: 4000 }),
    ], true)
    const q = usageRows(db, { now, windowDays: 30 }).find((r) => r.endpoint === '/query')!
    expect(q.calls).toBe(2)
    expect(q.bytesInKnown).toBe(1)
    expect(q.bytesOutKnown).toBe(1)
    expect(q.bytesOut).toBe(4000)

    // a genuinely zero-byte body is known, and stays distinguishable from unknown
    const emails = usageRows(db, { now, windowDays: 30 }).find((r) => r.method === 'GET' && r.endpoint === '/emails')!
    expect(emails.bytesIn).toBe(0)
    expect(emails.bytesInKnown).toBe(1)

    // and no token usage was reported at all, so the tokens column must be a gap too
    expect(q.tokenCalls).toBe(0)
  })
})

/** Insert n identical rows for a host+endpoint, so counts are predictable. */
function seed(db: StorageDriver, now: number, n: number, over: Record<string, unknown>) {
  const pid = ensureProject(db, { key: 'path:/x', name: 'app', rootPath: '/x', gitRoot: null })
  insertRows(db, pid, Array.from({ length: n }, () => fakeRow({
    startedAt: now - 1000, entityClass: 'general', provider: null, model: null,
    tokensIn: null, tokensOut: null, costUsd: null, ...over,
  } as any)), true)
}

describe('usageTree', () => {
  it('nests vendor > service > host > endpoint for a multi-service vendor', () => {
    seed(db, now, 5, { hostname: 's3.us-east-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key' })
    seed(db, now, 3, { hostname: 'bedrock-runtime.us-east-1.amazonaws.com', method: 'POST', normalizedEndpoint: '/model/:id/invoke' })

    const tree = usageTree(db, { now, windowDays: 30 })
    const aws = tree.find((n) => n.label === 'AWS')!

    expect(aws.kind).toBe('vendor')
    expect(aws.calls).toBe(8)
    expect(aws.children.map((c) => c.label).sort()).toEqual(['Bedrock', 's3'])

    const s3 = aws.children.find((c) => c.label === 's3')!
    expect(s3.kind).toBe('service')
    expect(s3.calls).toBe(5)
    // S3 has a single region here, so the host level collapses (see the
    // multi-region test below, where both hosts are kept)
    expect(s3.children[0].kind).toBe('endpoint')
    expect(s3.children[0].label).toBe('GET /:bucket/:key')
  })

  it('rolls cost, bytes, tokens and errors up to the vendor', () => {
    seed(db, now, 2, {
      hostname: 'bedrock-runtime.us-east-1.amazonaws.com', method: 'POST', normalizedEndpoint: '/model/:id/invoke',
      entityClass: 'llm', provider: 'bedrock', model: 'anthropic.claude-opus-5',
      tokensIn: 100, tokensOut: 20, costUsd: 0.005, reqBytes: 300, resBytes: 900, status: 200,
    })
    seed(db, now, 1, {
      hostname: 's3.us-east-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key',
      reqBytes: 50, resBytes: 4000, status: 500,
    })

    const aws = usageTree(db, { now, windowDays: 30 }).find((n) => n.label === 'AWS')!
    expect(aws.calls).toBe(3)
    expect(aws.costUsd).toBeCloseTo(0.01, 10)
    expect(aws.pricedCalls).toBe(2)
    expect(aws.tokensIn).toBe(200)
    expect(aws.tokensOut).toBe(40)
    expect(aws.bytesOut).toBe(2 * 900 + 4000)
    expect(aws.errors).toBe(1)
  })

  it('marks a node as llm when its host is an llm provider', () => {
    seed(db, now, 1, {
      hostname: 'bedrock-runtime.us-east-1.amazonaws.com', method: 'POST', normalizedEndpoint: '/model/:id/invoke',
      entityClass: 'llm', provider: 'bedrock', model: 'anthropic.claude-opus-5', tokensIn: 10, tokensOut: 2, costUsd: 0.001,
    })
    seed(db, now, 1, { hostname: 's3.us-east-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key' })
    const aws = usageTree(db, { now, windowDays: 30 }).find((n) => n.label === 'AWS')!
    expect(aws.children.find((c) => c.label === 'Bedrock')!.llm).toBe(true)
    expect(aws.children.find((c) => c.label === 's3')!.llm).toBe(false)
  })

  it('collapses single-child levels so one-service vendors go straight to endpoints', () => {
    seed(db, now, 4, { hostname: 'api.resend.com', method: 'POST', normalizedEndpoint: '/emails' })
    seed(db, now, 2, { hostname: 'api.resend.com', method: 'GET', normalizedEndpoint: '/domains' })

    const resend = usageTree(db, { now, windowDays: 30 }).find((n) => n.label === 'Resend')!
    // 6 seeded here + the 2 Resend rows from beforeEach
    expect(resend.calls).toBe(8)
    // vendor > service > host all had exactly one child and collapsed away
    expect(resend.children.every((c) => c.kind === 'endpoint')).toBe(true)
    expect(resend.children.map((c) => c.label).sort())
      .toEqual(['GET /domains', 'GET /emails', 'POST /emails'])
  })

  it('keeps the service level when a vendor really has several services', () => {
    seed(db, now, 5, { hostname: 's3.us-east-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key' })
    seed(db, now, 3, { hostname: 'bedrock-runtime.us-east-1.amazonaws.com', method: 'POST', normalizedEndpoint: '/model/:id/invoke' })

    const aws = usageTree(db, { now, windowDays: 30 }).find((n) => n.label === 'AWS')!
    expect(aws.children.map((c) => c.kind)).toEqual(['service', 'service'])
  })

  it('keeps every host when one service spans regions', () => {
    seed(db, now, 5, { hostname: 's3.us-east-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key' })
    seed(db, now, 2, { hostname: 's3.eu-west-1.amazonaws.com', method: 'GET', normalizedEndpoint: '/:bucket/:key' })

    const aws = usageTree(db, { now, windowDays: 30 }).find((n) => n.label === 'AWS')!
    // AWS has one service (S3) so that level collapses, leaving the two regions
    expect(aws.children.map((c) => c.kind)).toEqual(['host', 'host'])
    expect(aws.children.map((c) => c.label).sort())
      .toEqual(['s3.eu-west-1.amazonaws.com', 's3.us-east-1.amazonaws.com'])
  })
})
