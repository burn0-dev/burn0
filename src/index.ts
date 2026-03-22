import { getApiKey, detectMode, isTTY } from './config/env'
import { canPatch, markPatched, resetGuard, checkImportOrder } from './interceptor/guard'
import { patchFetch, unpatchFetch } from './interceptor/fetch'
import { patchHttp, unpatchHttp } from './interceptor/http'
import { createTracker } from './track'
import { createRestorer } from './restore'
import { createDispatcher } from './transport/dispatcher'
import { BatchBuffer } from './transport/batch'
import { LocalLedger } from './transport/local'
import { shipEvents } from './transport/api'
import { createTicker } from './transport/logger'
import { fetchPricing, estimateLocalCost } from './transport/local-pricing'
import type { Burn0Event } from './types'

const BURN0_API_URL = process.env.BURN0_API_URL ?? 'https://api.burn0.dev'

const apiKey = getApiKey()
const mode = detectMode({ isTTY: isTTY(), apiKey })

const { track, startSpan, enrichEvent } = createTracker()

// Store original fetch before patching (for API shipper and pricing fetch)
const originalFetch = globalThis.fetch

// Fetch pricing data from backend (non-blocking, uses original fetch)
if (mode !== 'test-disabled') {
  fetchPricing(BURN0_API_URL, originalFetch).catch(() => {})
}

// Always create ledger — used to seed today's cost for the ticker
const ledger = new LocalLedger(process.cwd())

// Seed ticker with today's prior costs from ledger
function getTodayDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let todayCost = 0
let todayCalls = 0
const perServiceCosts: Record<string, number> = {}

try {
  const todayStr = getTodayDateStr()
  const allEvents = ledger.read()
  for (const event of allEvents) {
    const eventDate = new Date(event.timestamp)
    const eventDateStr = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}-${String(eventDate.getDate()).padStart(2, '0')}`
    if (eventDateStr === todayStr) {
      todayCalls++
      const estimate = estimateLocalCost(event)
      if (estimate.type === 'priced' && estimate.cost > 0) {
        todayCost += estimate.cost
        perServiceCosts[event.service] = (perServiceCosts[event.service] ?? 0) + estimate.cost
      }
    }
  }
} catch {}

const ticker = createTicker({ todayCost, todayCalls, perServiceCosts })

let batch: BatchBuffer | null = null
if ((mode === 'dev-cloud' || mode === 'prod-cloud') && apiKey) {
  batch = new BatchBuffer({
    sizeThreshold: 50,
    timeThresholdMs: 10000,
    maxSize: 500,
    onFlush: (events) => {
      shipEvents(events, apiKey, BURN0_API_URL, originalFetch).catch(() => {})
    },
  })
}

const shouldWriteLedger = mode === 'dev-local' || mode === 'test-enabled'

const dispatch = createDispatcher(mode, {
  logEvent: (e) => ticker.tick(e),
  writeLedger: shouldWriteLedger ? (e) => ledger.write(e) : undefined,
  addToBatch: batch ? (e) => batch!.add(e) : undefined,
})

const preloaded = checkImportOrder()
if (preloaded.length > 0) {
  console.warn(`[burn0] Warning: These SDKs were imported before burn0 and may not be tracked: ${preloaded.join(', ')}. Move \`import 'burn0'\` to the top of your entry file.`)
}

if (canPatch() && mode !== 'test-disabled') {
  const onEvent = (event: Burn0Event) => {
    const enriched = enrichEvent(event)
    dispatch(enriched)
  }
  patchFetch(onEvent)
  patchHttp(onEvent)
  markPatched()
}

// Batch flush on exit (must be registered before ticker signal handlers)
if (batch) {
  const exitFlush = () => {
    batch!.flush()
    batch!.destroy()
  }
  process.on('beforeExit', exitFlush)
  process.on('SIGTERM', exitFlush)
  process.on('SIGINT', exitFlush)
  process.on('SIGHUP', exitFlush)
}

// Exit handlers — print ticker summary then re-emit signal
// Registered after batch flush so flush runs first (Node fires listeners in order)
const exitSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
for (const signal of exitSignals) {
  const handler = () => {
    ticker.printExitSummary()
    process.removeListener(signal, handler)
    process.kill(process.pid, signal)
  }
  process.on(signal, handler)
}
process.on('beforeExit', () => {
  ticker.printExitSummary()
})

const restore = createRestorer({ unpatchFetch, unpatchHttp, resetGuard })

export { track, startSpan, restore }
