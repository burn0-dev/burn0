# Live Cost Ticker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace burn0's scrolling stdout table with a single self-updating stderr line showing today's cumulative cost.

**Architecture:** Rewrite `logger.ts` as a ticker factory (`createTicker`), update the dispatcher to call `logEvent` in all modes except `test-disabled`, and rewire `index.ts` to seed the ticker from the local ledger on startup and print an exit summary on process end.

**Tech Stack:** TypeScript, Node.js (process.stderr, ANSI escape codes), vitest

**Spec:** `docs/superpowers/specs/2026-03-22-live-cost-ticker-design.md`

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/transport/logger.ts` | Rewrite | `createTicker()` factory — live line rendering, exit summary |
| `src/transport/dispatcher.ts` | Modify | Remove `accumulate`, add `logEvent` to `prod-cloud`/`prod-local` |
| `src/index.ts` | Modify | Seed ticker from ledger, wire exit handlers, remove `accumulatedEvents` |
| `tests/transport/logger.test.ts` | Rewrite | Tests for `createTicker`, tick, exit summary, TTY gating |
| `tests/transport/dispatcher.test.ts` | Modify | Update `prod-cloud`/`prod-local` expectations |
| `tests/index.test.ts` | Modify | Update if it references removed exports/behavior |

---

### Task 1: Rewrite `src/transport/logger.ts` — ticker core

**Files:**
- Rewrite: `src/transport/logger.ts`
- Test: `tests/transport/logger.test.ts`

- [ ] **Step 1: Write failing tests for `createTicker`**

Create `tests/transport/logger.test.ts` with the full test suite:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTicker } from '../../src/transport/logger'
import type { Burn0Event } from '../../src/types'

// Mock estimateLocalCost
vi.mock('../../src/transport/local-pricing', () => ({
  estimateLocalCost: vi.fn((event: any) => {
    if (event.service === 'free-svc') return { type: 'free' as const }
    if (event.service === 'unknown-svc') return { type: 'unknown' as const }
    if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
      return { type: 'priced' as const, cost: 0.01 }
    }
    return { type: 'no-tokens' as const }
  }),
}))

function makeEvent(overrides: Partial<Burn0Event> = {}): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    model: 'gpt-4o',
    tokens_in: 500,
    tokens_out: 250,
    status_code: 200,
    timestamp: new Date().toISOString(),
    duration_ms: 342,
    estimated: false,
    ...overrides,
  }
}

describe('createTicker', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a ticker with tick and printExitSummary methods', () => {
    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    expect(typeof ticker.tick).toBe('function')
    expect(typeof ticker.printExitSummary).toBe('function')
  })

  it('tick writes to stderr when isTTY is true', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })

    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())

    expect(stderrSpy).toHaveBeenCalled()
    const output = stderrSpy.mock.calls.map(c => c[0] as string).join('')
    expect(output).toContain('burn0')
    expect(output).toContain('$')

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('tick does NOT write to stderr when isTTY is false', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: false, writable: true })

    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())

    expect(stderrSpy).not.toHaveBeenCalled()

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('accumulates session cost across ticks', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })

    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    ticker.tick(makeEvent())
    ticker.tick(makeEvent())

    // Last write should contain the accumulated total
    const lastCall = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1][0] as string
    expect(lastCall).toContain('3 calls')

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('seeds today cost from init', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })

    const ticker = createTicker({ todayCost: 5.0, todayCalls: 20, perServiceCosts: { openai: 5.0 } })
    ticker.tick(makeEvent())

    const lastCall = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1][0] as string
    // Should show 21 calls (20 prior + 1 new)
    expect(lastCall).toContain('21 calls')

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('does not count free/unknown services in cost breakdown', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })

    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent({ service: 'free-svc' }))

    const lastCall = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1][0] as string
    expect(lastCall).not.toContain('free-svc')

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary writes session and today totals', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })

    const ticker = createTicker({ todayCost: 10.0, todayCalls: 50, perServiceCosts: {} })
    ticker.tick(makeEvent())
    stderrSpy.mockClear()

    ticker.printExitSummary()

    const output = stderrSpy.mock.calls.map(c => c[0] as string).join('')
    expect(output).toContain('session')
    expect(output).toContain('today')

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary is idempotent (only prints once)', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })

    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    stderrSpy.mockClear()

    ticker.printExitSummary()
    const firstCallCount = stderrSpy.mock.calls.length

    ticker.printExitSummary()
    expect(stderrSpy.mock.calls.length).toBe(firstCallCount)

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary does not print if no calls were made', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true })

    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.printExitSummary()

    expect(stderrSpy).not.toHaveBeenCalled()

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })

  it('printExitSummary does not write when stderr is not TTY', () => {
    const origIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: false, writable: true })

    const ticker = createTicker({ todayCost: 0, todayCalls: 0, perServiceCosts: {} })
    ticker.tick(makeEvent())
    ticker.printExitSummary()

    expect(stderrSpy).not.toHaveBeenCalled()

    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transport/logger.test.ts`
Expected: FAIL — `createTicker` is not exported from logger.ts

- [ ] **Step 3: Write `src/transport/logger.ts` implementation**

Replace the entire file with:

```typescript
import type { Burn0Event } from '../types'
import { estimateLocalCost, type CostEstimate } from './local-pricing'

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const BOLD = '\x1b[1m'
const ORANGE = '\x1b[38;2;250;93;25m'
const GRAY = '\x1b[90m'
const CLEAR_LINE = '\x1b[2K\r'

export interface TickerInit {
  todayCost: number
  todayCalls: number
  perServiceCosts: Record<string, number>
}

export interface Ticker {
  tick: (event: Burn0Event) => void
  printExitSummary: () => void
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(6)}`
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function formatServiceBreakdown(perServiceCosts: Record<string, number>, maxWidth: number): string {
  const sorted = Object.entries(perServiceCosts)
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])

  if (sorted.length === 0) return ''

  const parts: string[] = []
  let currentWidth = 0

  let shown = 0
  for (let i = 0; i < sorted.length && shown < 3; i++) {
    const [name, cost] = sorted[i]
    const part = `${name}: ${formatCost(cost)}`
    if (currentWidth + part.length + 3 > maxWidth && shown > 0) {
      break
    }
    parts.push(part)
    currentWidth += part.length + 3
    shown++
  }

  const remaining = sorted.length - shown
  if (remaining > 0) {
    parts.push(`+${remaining} more`)
  }

  return parts.join(' · ')
}

export function createTicker(init: TickerInit): Ticker {
  let sessionCost = 0
  let sessionCalls = 0
  const sessionStartTime = Date.now()

  let todayCost = init.todayCost
  let todayCalls = init.todayCalls
  const perServiceCosts = { ...init.perServiceCosts }

  let exitPrinted = false

  function render(): void {
    if (!process.stderr.isTTY) return
    if (todayCalls === 0) return

    const breakdown = formatServiceBreakdown(perServiceCosts, 40)
    const breakdownPart = breakdown ? ` ${GRAY}──${RESET} ${breakdown}` : ''
    const line = `${CLEAR_LINE}  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GREEN}${formatCost(todayCost)}${RESET} ${GRAY}today (${todayCalls} calls)${RESET}${breakdownPart}`

    process.stderr.write(line)
  }

  function tick(event: Burn0Event): void {
    const estimate = estimateLocalCost(event)

    todayCalls++
    sessionCalls++

    if (estimate.type === 'priced' && estimate.cost > 0) {
      todayCost += estimate.cost
      sessionCost += estimate.cost
      perServiceCosts[event.service] = (perServiceCosts[event.service] ?? 0) + estimate.cost
    }

    render()
  }

  function printExitSummary(): void {
    if (!process.stderr.isTTY) return
    if (sessionCalls === 0) return
    if (exitPrinted) return
    exitPrinted = true

    const duration = formatDuration(Date.now() - sessionStartTime)
    const line = `\n  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GRAY}session:${RESET} ${GREEN}${formatCost(sessionCost)}${RESET} ${GRAY}(${sessionCalls} calls, ${duration})${RESET} ${GRAY}──${RESET} ${GRAY}today:${RESET} ${GREEN}${formatCost(todayCost)}${RESET}\n`

    process.stderr.write(line)
  }

  return { tick, printExitSummary }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transport/logger.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/transport/logger.ts tests/transport/logger.test.ts
git commit -m "feat: rewrite logger as single-line stderr ticker"
```

---

### Task 2: Update `src/transport/dispatcher.ts` — remove accumulate, add logEvent to all modes

**Files:**
- Modify: `src/transport/dispatcher.ts`
- Modify: `tests/transport/dispatcher.test.ts`

- [ ] **Step 1: Replace dispatcher tests**

Replace the entire contents of `tests/transport/dispatcher.test.ts` with:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createDispatcher } from '../../src/transport/dispatcher'
import type { Burn0Event } from '../../src/types'

function makeEvent(): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    status_code: 200,
    timestamp: new Date().toISOString(),
    duration_ms: 100,
    estimated: false,
  }
}

describe('createDispatcher', () => {
  it('dev-local: calls logEvent and writeLedger', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('dev-local', { logEvent, writeLedger, addToBatch })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(writeLedger).toHaveBeenCalledOnce()
    expect(addToBatch).not.toHaveBeenCalled()
  })

  it('dev-cloud: calls logEvent and addToBatch', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('dev-cloud', { logEvent, writeLedger, addToBatch })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(addToBatch).toHaveBeenCalledOnce()
    expect(writeLedger).not.toHaveBeenCalled()
  })

  it('prod-cloud: calls logEvent and addToBatch', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('prod-cloud', { logEvent, writeLedger, addToBatch })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(addToBatch).toHaveBeenCalledOnce()
    expect(writeLedger).not.toHaveBeenCalled()
  })

  it('prod-local: calls logEvent only', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('prod-local', { logEvent, writeLedger, addToBatch })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(writeLedger).not.toHaveBeenCalled()
    expect(addToBatch).not.toHaveBeenCalled()
  })

  it('test-enabled: calls logEvent, writeLedger, and addToBatch', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('test-enabled', { logEvent, writeLedger, addToBatch })
    dispatch(makeEvent())

    expect(logEvent).toHaveBeenCalledOnce()
    expect(writeLedger).toHaveBeenCalledOnce()
    expect(addToBatch).toHaveBeenCalledOnce()
  })

  it('test-disabled: is a no-op (calls nothing)', () => {
    const logEvent = vi.fn()
    const writeLedger = vi.fn()
    const addToBatch = vi.fn()

    const dispatch = createDispatcher('test-disabled', { logEvent, writeLedger, addToBatch })
    dispatch(makeEvent())

    expect(logEvent).not.toHaveBeenCalled()
    expect(writeLedger).not.toHaveBeenCalled()
    expect(addToBatch).not.toHaveBeenCalled()
  })

  it('passes the event to all called deps', () => {
    const event = makeEvent()
    const logEvent = vi.fn()
    const writeLedger = vi.fn()

    const dispatch = createDispatcher('dev-local', { logEvent, writeLedger })
    dispatch(event)

    expect(logEvent).toHaveBeenCalledWith(event)
    expect(writeLedger).toHaveBeenCalledWith(event)
  })

  it('works without optional deps (no crash)', () => {
    const dispatch = createDispatcher('dev-local', {})
    expect(() => dispatch(makeEvent())).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transport/dispatcher.test.ts`
Expected: FAIL — `prod-cloud` and `prod-local` behavior doesn't match new expectations

- [ ] **Step 3: Update `src/transport/dispatcher.ts`**

Replace with:

```typescript
import type { Burn0Event, RuntimeMode } from '../types'

interface DispatcherDeps {
  logEvent?: (event: Burn0Event) => void
  writeLedger?: (event: Burn0Event) => void
  addToBatch?: (event: Burn0Event) => void
}

export function createDispatcher(mode: RuntimeMode, deps: DispatcherDeps): (event: Burn0Event) => void {
  return (event: Burn0Event) => {
    switch (mode) {
      case 'dev-local':
        deps.logEvent?.(event); deps.writeLedger?.(event); break
      case 'dev-cloud':
        deps.logEvent?.(event); deps.addToBatch?.(event); break
      case 'prod-cloud':
        deps.logEvent?.(event); deps.addToBatch?.(event); break
      case 'prod-local':
        deps.logEvent?.(event); break
      case 'test-enabled':
        deps.logEvent?.(event); deps.writeLedger?.(event); deps.addToBatch?.(event); break
      case 'test-disabled':
        break
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transport/dispatcher.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/transport/dispatcher.ts tests/transport/dispatcher.test.ts
git commit -m "refactor: remove accumulate dep, add logEvent to all modes"
```

---

### Task 3: Rewire `src/index.ts` — seed ticker, wire exit handlers

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update `src/index.ts`**

Replace the full file. Key changes from current:
- Import `createTicker` instead of `logEvent`/`formatProcessSummary`
- Always create `LocalLedger` (no mode gate)
- Read today's events from ledger, sum costs, seed the ticker
- Pass `ticker.tick` as `logEvent` to dispatcher
- Remove `accumulatedEvents` array
- Remove `accumulate` from dispatcher deps
- Remove `prod-local` formatProcessSummary exit handler
- Add exit signal handlers that call `ticker.printExitSummary()` with signal re-emission

```typescript
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
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS. Check `tests/index.test.ts` specifically for any failures related to removed exports.

- [ ] **Step 3: If `tests/index.test.ts` fails**

Read `tests/index.test.ts` and fix any references to `formatProcessSummary`, `logEvent`, or `accumulatedEvents`. These were internal and may or may not be tested directly. Fix as needed.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire ticker to index — seed from ledger, exit handlers"
```

---

### Task 4: Final integration test — run all tests, verify build

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No type errors

- [ ] **Step 4: Fix any failures**

If any test/build/lint failures, fix them. Common issues:
- `tests/index.test.ts` may reference old `logEvent` import
- Type mismatches if `accumulate` is still referenced somewhere
- Build output may warn about unused imports

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test and build issues from ticker refactor"
```
