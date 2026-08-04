import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Usage } from '../llm/parse.js'

export interface PriceEntry {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
}
export type PricingTable = Record<string, PriceEntry>

export const PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

interface CacheFile { fetchedAt: number; table: PricingTable }

function readCache(cacheDir: string): CacheFile | null {
  try {
    return JSON.parse(readFileSync(join(cacheDir, 'pricing.json'), 'utf8')) as CacheFile
  } catch {
    return null
  }
}

function readSnapshot(): PricingTable {
  const here = dirname(fileURLToPath(import.meta.url))
  // works from src (tests) and from dist (snapshot.json copied at build)
  for (const p of [join(here, 'snapshot.json'), join(here, 'pricing', 'snapshot.json')]) {
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch {}
  }
  return {}
}

export async function loadPricing(opts: {
  cacheDir: string
  ttlHours: number
  fetchFn?: typeof fetch
}): Promise<PricingTable> {
  const fetchFn = opts.fetchFn ?? fetch
  const cache = readCache(opts.cacheDir)
  const fresh = cache && Date.now() - cache.fetchedAt < opts.ttlHours * 3_600_000
  if (fresh) return cache.table
  try {
    const res = await fetchFn(PRICING_URL)
    if (!res.ok) throw new Error(`pricing fetch ${res.status}`)
    const table = (await res.json()) as PricingTable
    try {
      mkdirSync(opts.cacheDir, { recursive: true })
      writeFileSync(join(opts.cacheDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), table }))
    } catch {}
    return table
  } catch {
    if (cache) return cache.table // stale beats bundled
    return readSnapshot()
  }
}

/** Resolution order, and it matters more than which feed is chosen:
 *    1. `provider/model`  ← provider-qualified wins
 *    2. `model`           ← bare fallback
 *    3. unpriced          ← never $0.00
 *
 *  Bare-first was measurably wrong: 14 models price differently under the two
 *  keys, and a real Gemini call was billed at 1.5x. For open-weight models the
 *  hosting provider *is* the price, and burn0 already knows the host — bare-first
 *  threw that advantage away. `provider` may be null for gateway-routed calls,
 *  which correctly fall through to the bare lookup. */
export function computeCost(
  table: PricingTable, provider: string | null, model: string, usage: Usage,
): number | null {
  const entry = (provider ? table[`${provider}/${model}`] : undefined) ?? table[model]
  if (!entry) return null
  // A $0/$0 entry is unpriced, not free: 70 chat models in LiteLLM carry zeros,
  // some genuinely free and some placeholders, and the data cannot distinguish
  // them. Multiplying by zero would write a paid call to the DB as free.
  if (!entry.input_cost_per_token && !entry.output_cost_per_token) return null
  const cached = usage.tokensCached ?? 0
  const uncachedIn = Math.max(0, (usage.tokensIn ?? 0) - cached)
  const cost =
    uncachedIn * (entry.input_cost_per_token ?? 0) +
    cached * (entry.cache_read_input_token_cost ?? entry.input_cost_per_token ?? 0) +
    (usage.tokensOut ?? 0) * (entry.output_cost_per_token ?? 0)
  return cost
}
