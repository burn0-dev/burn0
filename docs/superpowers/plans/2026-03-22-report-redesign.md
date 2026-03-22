# `burn0 report` Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `burn0 report` to show actual dollar costs by service with a day-by-day breakdown, pulling data from backend or local ledger.

**Architecture:** Single file rewrite of `src/cli/report.ts` with data aggregation logic, formatting helpers, and backend/local data source switching. Minor update to `src/cli/index.ts` for the `--today` flag.

**Tech Stack:** TypeScript, chalk, vitest

**Spec:** `docs/superpowers/specs/2026-03-22-report-redesign.md`

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/cli/report.ts` | Rewrite | Data fetching, cost aggregation, formatted output |
| `src/cli/index.ts` | Modify | Add `--today` option to report command |
| `tests/cli/report.test.ts` | Rewrite | Test aggregation logic and output formatting |

---

### Task 1: Rewrite `src/cli/report.ts` with cost aggregation and formatted output

**Files:**
- Rewrite: `src/cli/report.ts`
- Rewrite: `tests/cli/report.test.ts`

- [ ] **Step 1: Write tests for the report aggregation and formatting**

Replace `tests/cli/report.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LocalLedger } from '../../src/transport/local'
import type { Burn0Event } from '../../src/types'

// Mock estimateLocalCost
vi.mock('../../src/transport/local-pricing', () => ({
  estimateLocalCost: vi.fn((event: any) => {
    if (event.service === 'github-api') return { type: 'free' as const }
    if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
      return { type: 'priced' as const, cost: 0.01 }
    }
    return { type: 'unknown' as const }
  }),
  fetchPricing: vi.fn(async () => {}),
}))

function makeEvent(overrides: Partial<Burn0Event> = {}): Burn0Event {
  return {
    schema_version: 1,
    service: 'openai',
    endpoint: '/v1/chat/completions',
    model: 'gpt-4o-mini',
    tokens_in: 500,
    tokens_out: 100,
    status_code: 200,
    timestamp: new Date().toISOString(),
    duration_ms: 200,
    estimated: false,
    ...overrides,
  }
}

describe('report aggregation', () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-report-')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('aggregates costs by service from ledger events', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const ledger = new LocalLedger(tmpDir)
    ledger.write(makeEvent({ service: 'openai' }))
    ledger.write(makeEvent({ service: 'openai' }))
    ledger.write(makeEvent({ service: 'anthropic' }))

    const result = aggregateLocal(ledger.read(), 7)
    expect(result.total.calls).toBe(3)
    expect(result.total.cost).toBeGreaterThan(0)
    expect(result.byService.length).toBe(2)
    expect(result.byService[0].name).toBe('openai')
    expect(result.byService[0].calls).toBe(2)
  })

  it('excludes free services from cost summary', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const ledger = new LocalLedger(tmpDir)
    ledger.write(makeEvent({ service: 'openai' }))
    ledger.write(makeEvent({ service: 'github-api' }))

    const result = aggregateLocal(ledger.read(), 7)
    expect(result.total.calls).toBe(2)
    expect(result.byService.length).toBe(1) // github-api excluded
    expect(result.byService[0].name).toBe('openai')
  })

  it('filters events by date range', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const today = new Date()
    const oldDate = new Date(today)
    oldDate.setDate(oldDate.getDate() - 10)

    const events = [
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: oldDate.toISOString() }),
    ]

    const result = aggregateLocal(events, 7)
    expect(result.total.calls).toBe(1) // old event filtered out
  })

  it('groups events by day for daily breakdown', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const events = [
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: yesterday.toISOString() }),
    ]

    const result = aggregateLocal(events, 7)
    expect(result.byDay.length).toBe(2)
  })

  it('returns empty result for no events', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const result = aggregateLocal([], 7)
    expect(result.total.calls).toBe(0)
    expect(result.total.cost).toBe(0)
    expect(result.byService.length).toBe(0)
    expect(result.byDay.length).toBe(0)
  })

  it('tracks all service call counts including free services', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const events = [
      makeEvent({ service: 'openai' }),
      makeEvent({ service: 'github-api' }),
      makeEvent({ service: 'github-api' }),
    ]
    const result = aggregateLocal(events, 7)
    expect(result.allServiceCalls.length).toBe(2)
    expect(result.allServiceCalls.find(s => s.name === 'github-api')?.calls).toBe(2)
  })

  it('filters to today only when days=1', async () => {
    const { aggregateLocal } = await import('../../src/cli/report')
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const events = [
      makeEvent({ timestamp: today.toISOString() }),
      makeEvent({ timestamp: yesterday.toISOString() }),
    ]

    const result = aggregateLocal(events, 1)
    expect(result.total.calls).toBe(1) // only today's event
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/report.test.ts`
Expected: FAIL — `aggregateLocal` is not exported from report.ts

- [ ] **Step 3: Write `src/cli/report.ts` implementation**

Replace the entire file with:

```typescript
import chalk from 'chalk'
import { LocalLedger } from '../transport/local'
import { estimateLocalCost, fetchPricing } from '../transport/local-pricing'
import { getApiKey } from '../config/env'
import type { Burn0Event } from '../types'

const BURN0_API_URL = process.env.BURN0_API_URL ?? 'https://api.burn0.dev'

interface ReportData {
  total: { cost: number; calls: number }
  byService: { name: string; cost: number; calls: number }[]
  byDay: { date: string; cost: number; calls: number; topServices: { name: string; cost: number }[] }[]
  allServiceCalls: { name: string; calls: number }[] // all services by call count (for call-count-only fallback)
  unpricedCount: number
  pricingAvailable: boolean
}

function getLocalDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(6)}`
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')}`
}

function makeBar(value: number, max: number, width: number): string {
  if (max === 0) return '░'.repeat(width)
  const filled = Math.round((value / max) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function aggregateLocal(events: Burn0Event[], days: number): ReportData {
  // For --today (days=1), cutoff is start of today. For 7 days, cutoff is 6 days ago (7 days including today).
  const now = new Date()
  const cutoffDate = new Date(now)
  cutoffDate.setDate(cutoffDate.getDate() - (days - 1))
  const cutoffStr = getLocalDateStr(cutoffDate)

  const serviceCosts: Record<string, { cost: number; calls: number }> = {}
  const serviceCallCounts: Record<string, number> = {} // all services, regardless of pricing
  const dayCosts: Record<string, { cost: number; calls: number; services: Record<string, number> }> = {}
  let totalCost = 0
  let totalCalls = 0
  let unpricedCount = 0
  let loadingCount = 0

  for (const event of events) {
    const eventDate = new Date(event.timestamp)
    const eventDateStr = getLocalDateStr(eventDate)

    if (eventDateStr < cutoffStr) continue

    totalCalls++
    serviceCallCounts[event.service] = (serviceCallCounts[event.service] ?? 0) + 1
    const estimate = estimateLocalCost(event)

    if (estimate.type === 'priced' && estimate.cost > 0) {
      totalCost += estimate.cost

      if (!serviceCosts[event.service]) serviceCosts[event.service] = { cost: 0, calls: 0 }
      serviceCosts[event.service].cost += estimate.cost
      serviceCosts[event.service].calls++

      if (!dayCosts[eventDateStr]) dayCosts[eventDateStr] = { cost: 0, calls: 0, services: {} }
      dayCosts[eventDateStr].cost += estimate.cost
      dayCosts[eventDateStr].calls++
      dayCosts[eventDateStr].services[event.service] = (dayCosts[eventDateStr].services[event.service] ?? 0) + estimate.cost
    } else if (estimate.type === 'free') {
      // Count call but don't add to cost or service list
    } else if (estimate.type === 'loading') {
      loadingCount++
    } else {
      unpricedCount++
    }
  }

  const byService = Object.entries(serviceCosts)
    .map(([name, data]) => ({ name, cost: data.cost, calls: data.calls }))
    .sort((a, b) => b.cost - a.cost)

  const allServiceCalls = Object.entries(serviceCallCounts)
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls)

  const byDay = Object.entries(dayCosts)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, data]) => {
      const topServices = Object.entries(data.services)
        .sort((a, b) => b[1] - a[1])
        .map(([name, cost]) => ({ name, cost }))
      return { date, cost: data.cost, calls: data.calls, topServices }
    })

  return {
    total: { cost: totalCost, calls: totalCalls },
    byService,
    byDay,
    allServiceCalls,
    unpricedCount,
    pricingAvailable: loadingCount < totalCalls || totalCalls === 0,
  }
}

function renderCallCountOnly(data: ReportData): void {
  const maxCalls = data.allServiceCalls.length > 0 ? data.allServiceCalls[0].calls : 0
  const maxNameLen = Math.max(...data.allServiceCalls.map(s => s.name.length), 8)
  for (const svc of data.allServiceCalls) {
    const bar = makeBar(svc.calls, maxCalls, 20)
    console.log(`  ${svc.name.padEnd(maxNameLen)}  ${chalk.gray(`${String(svc.calls).padStart(5)} calls`)}  ${chalk.cyan(bar)}`)
  }
  console.log()
}

function renderCostReport(data: ReportData, label: string, showDaily: boolean, isToday: boolean): void {
  console.log(`\n  ${chalk.hex('#FA5D19').bold('burn0 report')} ${chalk.gray(`── ${label}`)}\n`)

  if (data.total.calls === 0) {
    const msg = isToday ? 'No calls today.' : `No cost data yet. Run your app with \`import '@burn0/burn0'\` to start tracking.`
    console.log(chalk.dim(`  ${msg}\n`))
    return
  }

  if (!data.pricingAvailable) {
    // All events returned 'loading' — pricing not available
    console.log(chalk.dim(`  ${data.total.calls} calls tracked (pricing data not available)\n`))
    renderCallCountOnly(data)
    return
  }

  if (data.total.cost === 0 && data.total.calls > 0) {
    // Has calls but zero cost — show call-count-only
    console.log(chalk.dim(`  ${data.total.calls} calls tracked (no pricing data available)\n`))
    renderCallCountOnly(data)
    return
  }

  // Summary
  console.log(`  ${chalk.bold('Total:')} ${chalk.green(formatCost(data.total.cost))} ${chalk.gray(`(${data.total.calls} calls)`)}\n`)

  // Per-service breakdown
  const maxCost = data.byService.length > 0 ? data.byService[0].cost : 0
  const maxNameLen = Math.max(...data.byService.map(s => s.name.length), 8)

  for (const svc of data.byService) {
    const pct = data.total.cost > 0 ? Math.round((svc.cost / data.total.cost) * 100) : 0
    const bar = makeBar(svc.cost, maxCost, 20)
    console.log(`  ${svc.name.padEnd(maxNameLen)}  ${chalk.green(formatCost(svc.cost).padStart(10))}   ${chalk.cyan(bar)}  ${chalk.gray(`${String(pct).padStart(3)}%`)}`)
  }

  if (data.unpricedCount > 0) {
    console.log(chalk.dim(`\n  + ${data.unpricedCount} calls not priced`))
  }

  // Daily breakdown
  if (showDaily && data.byDay.length > 0) {
    console.log(`\n  ${chalk.gray('── daily ──────────────────────────────────────')}\n`)

    const maxDayCost = Math.max(...data.byDay.map(d => d.cost))

    for (const day of data.byDay) {
      const dateLabel = formatDateLabel(day.date)
      const bar = makeBar(day.cost, maxDayCost, 12)
      const top2 = day.topServices.slice(0, 2).map(s => `${s.name} ${formatCost(s.cost)}`).join(' · ')
      const more = day.topServices.length > 2 ? ` +${day.topServices.length - 2} more` : ''
      console.log(`  ${chalk.gray(dateLabel)}   ${chalk.green(formatCost(day.cost).padStart(10))}  ${chalk.cyan(bar)}  ${chalk.dim(top2 + more)}`)
    }
  }

  console.log()
}

async function fetchBackendReport(apiKey: string, days: number): Promise<ReportData | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await globalThis.fetch(`${BURN0_API_URL}/v1/report?days=${days}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) return null

    const data = await response.json() as any
    return {
      total: data.total ?? { cost: 0, calls: 0 },
      byService: data.byService ?? [],
      byDay: data.byDay ?? [],
      allServiceCalls: (data.byService ?? []).map((s: any) => ({ name: s.name, calls: s.calls })),
      unpricedCount: 0,
      pricingAvailable: true,
    }
  } catch {
    return null
  }
}

export async function runReport(options: { today?: boolean } = {}): Promise<void> {
  const cwd = process.cwd()
  const days = options.today ? 1 : 7
  const label = options.today ? 'today' : 'last 7 days'

  // Try backend first if API key is set
  const apiKey = getApiKey()
  if (apiKey) {
    const backendData = await fetchBackendReport(apiKey, days)
    if (backendData) {
      renderCostReport(backendData, label, !options.today, !!options.today)
      return
    }
  }

  // Fall back to local ledger
  await fetchPricing(BURN0_API_URL, globalThis.fetch)

  const ledger = new LocalLedger(cwd)
  const events = ledger.read()
  const data = aggregateLocal(events, days)
  renderCostReport(data, label, !options.today, !!options.today)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/report.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/report.ts tests/cli/report.test.ts
git commit -m "feat: rewrite report with cost breakdown and daily view"
```

---

### Task 2: Add `--today` flag to CLI command definition

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Update the report command in `src/cli/index.ts`**

Find (around line 35-41):
```typescript
program
  .command('report')
  .description('Show cost summary')
  .action(async () => {
    const { runReport } = await import('./report')
    await runReport()
  })
```

Replace with:
```typescript
program
  .command('report')
  .description('Show cost summary')
  .option('--today', 'Show today only')
  .action(async (options: { today?: boolean }) => {
    const { runReport } = await import('./report')
    await runReport(options)
  })
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: add --today flag to burn0 report"
```

---

### Task 3: Final integration — test, build, lint

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No type errors

- [ ] **Step 4: Manual test with local ledger**

Run: `npx tsx src/cli/index.ts report`
Expected: Shows cost report from local ledger data (if `.burn0/costs.jsonl` exists)

Run: `npx tsx src/cli/index.ts report --today`
Expected: Shows today-only report

- [ ] **Step 5: Fix any issues and commit**

```bash
git add -A
git commit -m "fix: resolve integration issues from report redesign"
```
