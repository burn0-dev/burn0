/**
 * Pricing data for terminal display.
 * Fetched from the burn0 backend on startup, cached locally.
 * Falls back to "no cost display" if backend is unreachable.
 */
import fs from 'node:fs'
import path from 'node:path'

interface PricingData {
  version: number
  updated_at: string
  services: Record<string, any>
}

let pricingData: PricingData | null = null
const CACHE_FILE = '.burn0/pricing-cache.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Free services — no API call cost
const FREE_SERVICES = new Set([
  'github-api', 'slack-api', 'discord-api',
])

export type CostEstimate =
  | { type: 'priced'; cost: number }
  | { type: 'free' }
  | { type: 'no-tokens' }
  | { type: 'fixed-tier' }
  | { type: 'unknown' }
  | { type: 'loading' } // pricing not fetched yet

/**
 * Fetch pricing from backend and cache locally.
 * Non-blocking — called on init, doesn't delay the app.
 */
export async function fetchPricing(
  apiUrl: string,
  fetchFn: typeof globalThis.fetch
): Promise<void> {
  // Try cache first
  try {
    const cachePath = path.join(process.cwd(), CACHE_FILE)
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf-8')
      const cached = JSON.parse(raw) as PricingData & { cached_at: number }
      if (Date.now() - cached.cached_at < CACHE_TTL_MS) {
        pricingData = cached
        return
      }
    }
  } catch {}

  // Fetch from backend
  try {
    const response = await fetchFn(`${apiUrl}/v1/pricing`, {
      headers: { 'Accept': 'application/json' },
    })
    if (response.ok) {
      const data = await response.json() as PricingData
      pricingData = data

      // Cache to disk
      try {
        const dir = path.join(process.cwd(), '.burn0')
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(process.cwd(), CACHE_FILE),
          JSON.stringify({ ...data, cached_at: Date.now() }, null, 2)
        )
      } catch {}
    }
  } catch {}
}

export function estimateLocalCost(event: {
  service: string
  model?: string
  tokens_in?: number
  tokens_out?: number
  endpoint?: string
  status_code?: number
}): CostEstimate {
  // Free services
  if (FREE_SERVICES.has(event.service)) {
    return { type: 'free' }
  }

  // Unknown services
  if (event.service.startsWith('unknown:')) {
    return { type: 'unknown' }
  }

  // No pricing data loaded yet
  if (!pricingData) {
    return { type: 'loading' }
  }

  const svc = pricingData.services[event.service]
  if (!svc) {
    return { type: 'unknown' }
  }

  // LLM pricing
  if (svc.type === 'llm') {
    if (!event.model) return { type: 'unknown' }
    if (event.tokens_in === undefined || event.tokens_out === undefined) {
      return { type: 'no-tokens' }
    }

    // Try exact match, then prefix match
    let prices: [number, number] | undefined = svc.models[event.model]
    if (!prices) {
      const match = Object.keys(svc.models).find((m: string) => event.model!.startsWith(m))
      if (match) prices = svc.models[match]
    }
    if (prices) {
      const inputCost = (event.tokens_in / 1_000_000) * prices[0]
      const outputCost = (event.tokens_out / 1_000_000) * prices[1]
      return { type: 'priced', cost: inputCost + outputCost }
    }
    return { type: 'unknown' }
  }

  // API pricing with endpoint matching
  if (svc.type === 'api') {
    const endpoint = event.endpoint ?? ''
    // Try prefix match
    for (const [prefix, cost] of Object.entries(svc.endpoints)) {
      if (prefix !== '*' && endpoint.startsWith(prefix)) {
        return (cost as number) === 0 ? { type: 'free' } : { type: 'priced', cost: cost as number }
      }
    }
    // Fall back to default
    const defaultCost = svc.endpoints['*'] as number | undefined
    if (defaultCost !== undefined) {
      return defaultCost === 0 ? { type: 'free' } : { type: 'priced', cost: defaultCost }
    }
    return { type: 'unknown' }
  }

  // Fixed-tier services
  if (svc.type === 'fixed') {
    return { type: 'fixed-tier' }
  }

  return { type: 'unknown' }
}
