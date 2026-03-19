import { getApiKey, detectMode, isTTY } from './config/env'
import { canPatch, markPatched, resetGuard } from './interceptor/guard'
import { patchFetch, unpatchFetch } from './interceptor/fetch'
import { patchHttp, unpatchHttp } from './interceptor/http'
import { createTracker } from './track'
import { createRestorer } from './restore'
import { createDispatcher } from './transport/dispatcher'
import { BatchBuffer } from './transport/batch'
import { LocalLedger } from './transport/local'
import { shipEvents } from './transport/api'
import { logEvent, formatProcessSummary } from './transport/logger'
import type { Burn0Event } from './types'

const BURN0_API_URL = 'https://api.burn0.dev'

const apiKey = getApiKey()
const mode = detectMode({ isTTY: isTTY(), apiKey })

const { track, startSpan, enrichEvent } = createTracker()

// Store original fetch before patching (for API shipper to avoid recursion)
const originalFetch = globalThis.fetch

const accumulatedEvents: Burn0Event[] = []

const ledger = (mode === 'dev-local' || mode === 'test-enabled')
  ? new LocalLedger(process.cwd())
  : null

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

const dispatch = createDispatcher(mode, {
  logEvent,
  writeLedger: ledger ? (e) => ledger.write(e) : undefined,
  addToBatch: batch ? (e) => batch!.add(e) : undefined,
  accumulate: (e) => accumulatedEvents.push(e),
})

if (canPatch() && mode !== 'test-disabled') {
  const onEvent = (event: Burn0Event) => {
    const enriched = enrichEvent(event)
    dispatch(enriched)
  }
  patchFetch(onEvent)
  patchHttp(onEvent)
  markPatched()
}

if (mode === 'prod-local') {
  const startTime = Date.now()
  process.on('beforeExit', () => {
    if (accumulatedEvents.length > 0) {
      const uptimeSeconds = (Date.now() - startTime) / 1000
      console.log(formatProcessSummary(accumulatedEvents, uptimeSeconds))
    }
  })
}

if (batch) {
  const exitFlush = () => { batch!.flush() }
  process.on('beforeExit', exitFlush)
  process.on('SIGTERM', exitFlush)
  process.on('SIGINT', exitFlush)
}

const restore = createRestorer({ unpatchFetch, unpatchHttp, resetGuard })

export { track, startSpan, restore }
