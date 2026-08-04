import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPricing, computeCost } from '../src/pricing/index.js'

const okFetch = (body: object) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
const failFetch = (async () => { throw new Error('offline') }) as typeof fetch

describe('loadPricing', () => {
  it('fetches remote table and writes cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-'))
    const table = await loadPricing({ cacheDir: dir, ttlHours: 24, fetchFn: okFetch({ 'gpt-4o': { input_cost_per_token: 1 } }) })
    expect(table['gpt-4o'].input_cost_per_token).toBe(1)
    expect(existsSync(join(dir, 'pricing.json'))).toBe(true)
  })
  it('uses fresh cache without fetching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-'))
    writeFileSync(join(dir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), table: { m: { input_cost_per_token: 2 } } }))
    const table = await loadPricing({ cacheDir: dir, ttlHours: 24, fetchFn: failFetch })
    expect(table['m'].input_cost_per_token).toBe(2)
  })
  it('falls back to stale cache then bundled snapshot when fetch fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-'))
    const table = await loadPricing({ cacheDir: dir, ttlHours: 24, fetchFn: failFetch })
    expect(table['gpt-4o']).toBeDefined() // from snapshot.json
  })
})

describe('computeCost resolution order', () => {
  // 14 models price differently bare vs provider-qualified. For open-weight
  // models the hosting provider *is* the price, and burn0 already knows the host.
  const table = {
    'gemini-2.0-flash-001': { input_cost_per_token: 1.5e-7, output_cost_per_token: 0 },
    'gemini/gemini-2.0-flash-001': { input_cost_per_token: 1e-7, output_cost_per_token: 0 },
    'bare-only': { input_cost_per_token: 2e-6, output_cost_per_token: 0 },
    'free-model': { input_cost_per_token: 0, output_cost_per_token: 0 },
  }
  const use = { tokensIn: 1_000_000, tokensOut: 0, tokensCached: null, tokensCacheWrite: null, inputIncludesCache: true }

  it('prefers the provider-qualified entry over the bare name', () => {
    // bare-first billed Gemini at 1.5x the correct rate
    expect(computeCost(table, 'gemini', 'gemini-2.0-flash-001', use)).toBeCloseTo(0.1, 10)
  })

  it('falls back to the bare name when there is no qualified entry', () => {
    expect(computeCost(table, 'gemini', 'bare-only', use)).toBeCloseTo(2, 10)
  })

  it('prices a gateway-routed call with no known provider', () => {
    expect(computeCost(table, null, 'bare-only', use)).toBeCloseTo(2, 10)
  })

  it('treats a $0/$0 entry as unpriced, not as free', () => {
    // 70 chat models in LiteLLM carry 0/0; some are genuinely free and some are
    // not, and the data cannot tell them apart. When it cannot be resolved,
    // render a gap rather than assert $0.00.
    expect(computeCost(table, null, 'free-model', use)).toBeNull()
  })
})

describe('computeCost', () => {
  const table = {
    'gpt-4o': { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.000001 },
    'groq/llama-3.3-70b': { input_cost_per_token: 0.0000005, output_cost_per_token: 0.0000005 },
  }
  it('computes cost with cached tokens billed at cache rate', () => {
    // 1000 in (200 cached) + 100 out: (800*2e-6)+(200*1e-6)+(100*1e-5) = 0.0028
    expect(computeCost(table, 'openai', 'gpt-4o', { tokensIn: 1000, tokensOut: 100, tokensCached: 200, tokensCacheWrite: null, inputIncludesCache: true })).toBeCloseTo(0.0028, 10)
  })
  it('falls back to provider/model key', () => {
    expect(computeCost(table, 'groq', 'llama-3.3-70b', { tokensIn: 10, tokensOut: 10, tokensCached: null, tokensCacheWrite: null, inputIncludesCache: true })).toBeCloseTo(0.00001, 12)
  })
  it('returns null for unknown model', () => {
    expect(computeCost(table, 'openai', 'unknown-model', { tokensIn: 10, tokensOut: 10, tokensCached: null, tokensCacheWrite: null, inputIncludesCache: true })).toBeNull()
  })
})
