import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRows, type StorageDriver } from '@burn0/core'
import type { EnrichedRow } from '@burn0/core'

export type SeedRow = EnrichedRow

export function baseRow(over: Partial<EnrichedRow> = {}): EnrichedRow {
  return {
    startedAt: Date.now(), method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
    hostname: 'api.openai.com', status: 200, firstByteMs: 40, latencyMs: 300,
    reqBytes: 100, resBytes: 500, reqHeaders: {}, resHeaders: {},
    reqBody: '{"model":"gpt-4o"}', resBody: '{"ok":true}', stackSnippet: 'at handler (server.js:10)',
    tags: null, estimated: false, trace: null,
    entity: 'OpenAI', entityClass: 'llm', provider: 'openai',
    normalizedEndpoint: '/v1/chat/completions', model: 'gpt-4o',
    tokensIn: 100, tokensOut: 20, tokensCached: null, tokensCacheWrite: null, costUsd: 0.0005,
    reqTruncated: false, resTruncated: false,
    ...over,
  }
}

export function seedDb(rows: Partial<EnrichedRow>[] = [{}]): { db: StorageDriver; dbPath: string } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'burn0-cli-')), 'burn0.db')
  const db = openDatabase(dbPath)
  const pid = ensureProject(db, { key: 'path:/x', name: 'test-app', rootPath: '/x', gitRoot: null })
  insertRows(db, pid, rows.map(baseRow), true)
  return { db, dbPath }
}
