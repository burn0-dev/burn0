# `burn0 report` Redesign — Design Spec

## Problem

The current `burn0 report` command shows call counts per service with bar charts but no dollar amounts. For a cost observability tool, the one command users reach for doesn't answer the basic question: "how much did I spend?"

## Solution

Rewrite `burn0 report` to show actual costs — a summary by service on top, and a day-by-day breakdown below. Data comes from the backend API when an API key is set, with fallback to the local ledger.

## Command Interface

- `burn0 report` — shows last 7 days (default)
- `burn0 report --today` — shows today only

## Data Source

| Condition | Source | Fallback |
|---|---|---|
| API key set + backend reachable | Backend API: `GET /v1/report?days=7` | Local ledger |
| API key set + backend unreachable | Local ledger | — |
| No API key | Local ledger | — |

- Backend fetch uses `globalThis.fetch` directly — the CLI entry point (`src/cli/index.ts`) does not import the SDK, so fetch is never patched. No "originalFetch" pattern needed.
- Backend returns pre-calculated cost summaries (costs computed server-side from ingested events).
- Local mode computes costs on-the-fly using `estimateLocalCost()` from `local-pricing.ts` for each event in the ledger.
- API base URL resolved from `process.env.BURN0_API_URL ?? 'https://api.burn0.dev'` (same as SDK runtime).
- Backend fetch timeout: 5 seconds. On timeout or error, silently fall back to local.
- For `--today`, pass `?days=1` to the backend.

## Output Format

### 7-day report (default)

```
  burn0 report ── last 7 days

  Total: $12.47 (342 calls)

  openai         $8.32   ██████████████░░░░░░  67%
  anthropic      $3.15   ██████░░░░░░░░░░░░░░  25%
  google-gemini  $0.85   ██░░░░░░░░░░░░░░░░░░   7%
  resend         $0.15   ░░░░░░░░░░░░░░░░░░░░   1%

  ── daily ──────────────────────────────────────

  Mar 22   $3.41  ████████░░░░  openai $2.80 · anthropic $0.61
  Mar 21   $2.18  █████░░░░░░░  openai $1.90 · anthropic $0.28
  Mar 20   $1.95  █████░░░░░░░  openai $1.20 · gemini $0.75
  Mar 19   $2.04  █████░░░░░░░  anthropic $1.50 · openai $0.54
  Mar 18   $1.42  ████░░░░░░░░  openai $1.42
  Mar 17   $0.89  ██░░░░░░░░░░  openai $0.89
  Mar 16   $0.58  █░░░░░░░░░░░  gemini $0.58
```

### Today report (`--today`)

```
  burn0 report ── today

  Total: $3.41 (48 calls)

  openai         $2.80   ██████████████████░░  82%
  anthropic      $0.61   ████░░░░░░░░░░░░░░░░  18%
```

No daily breakdown section when `--today` — just the summary.

### No data

```
  burn0 report

  No cost data yet. Run your app with `import '@burn0/burn0'` to start tracking.
```

### Zero cost but has calls

```
  burn0 report ── last 7 days

  342 calls tracked (no pricing data available)

  openai         142 calls  ██████████████░░░░░░
  anthropic       98 calls  ██████░░░░░░░░░░░░░░
  google-gemini   65 calls  ████░░░░░░░░░░░░░░░░
  resend          37 calls  ███░░░░░░░░░░░░░░░░░
```

Falls back to call counts when pricing data isn't available (no backend, no pricing cache).

## Formatting Details

- Bar chart width: 20 characters. `█` for filled, `░` for empty.
- Bar proportional to highest value (longest bar = 20 chars).
- Service names left-aligned, padded to longest name + 2 spaces.
- Costs right-aligned within their column.
- Percentage shown as integer (rounded), right-aligned.
- Daily breakdown shows top 2 services per day with `·` separator. If more than 2, shows `+N more` at the end, e.g.: `openai $2.80 · anthropic $0.61 +2 more`
- Dates formatted as `Mon DD` (e.g., `Mar 22`).
- Services with $0.00 cost excluded from the summary (e.g., GitHub API which is free).
- Services sorted by cost descending.
- All output uses chalk for colors: orange for `burn0`, green for costs, gray for dim text, cyan for bars.

## Cost Calculation (Local Mode)

### Pricing Data Loading

The CLI entry point does not import the SDK, so `pricingData` in `local-pricing.ts` is not populated by default. The report command must **load pricing before computing costs**:

1. Call `fetchPricing(apiUrl, globalThis.fetch)` and `await` it (blocking — the report needs pricing before it can compute costs)
2. If fetch fails (backend unreachable, no cache), `pricingData` stays null and `estimateLocalCost` returns `{ type: 'loading' }` for all events
3. If cache exists (`.burn0/pricing-cache.json`), it loads from there without hitting the backend

This is different from the SDK runtime where `fetchPricing` is fire-and-forget. In the report command, we await it because we need the result before we can render.

### Aggregation Steps

1. Load pricing data via `await fetchPricing(apiUrl, globalThis.fetch)`
2. Read all events from local ledger via `ledger.read()`
3. Filter by date range (today or last 7 days) using local timezone date comparison (same logic as ticker seeding in `index.ts`)
4. For each event, call `estimateLocalCost(event)` to get cost estimate
5. Handle each cost type:
   - `'priced'` → add to cost totals and service breakdown
   - `'free'` → count in total calls, exclude from cost summary and service list
   - `'no-tokens'`, `'fixed-tier'`, `'unknown'` → count in total calls, add to "unpriced" count
   - `'loading'` → pricing data not available. If ALL events return `'loading'`, show a distinct message: "Pricing data not available. Showing call counts only."
6. Aggregate by service (for summary) and by day (for daily breakdown)
7. If zero events have priced costs but calls exist, show call-count-only format

## Backend Report Response (Expected Contract)

When the backend endpoint exists, `GET /v1/report?days=7` should return:

```typescript
interface ReportResponse {
  period: { start: string; end: string; days: number }
  total: { cost: number; calls: number }
  byService: { name: string; cost: number; calls: number }[]
  byDay: { date: string; cost: number; calls: number; topServices: { name: string; cost: number }[] }[]
}
```

This endpoint does not exist yet — it will be built separately in the backend repo. The report command detects a missing/failing endpoint and falls back to local data.

## Files to Change

### `src/cli/report.ts` — Rewrite

Remove:
- Current implementation that only shows call counts with bar charts

Add:
- Accept `options: { today?: boolean }` parameter (passed from commander)
- `--today` flag via commander option
- Data source selection: try backend if API key set, fall back to local
- Local cost aggregation: read ledger, filter by date, compute costs via `estimateLocalCost`
- Summary section: total cost, per-service breakdown with bars and percentages
- Daily section: day-by-day breakdown with top services per day
- No-data and no-pricing fallback displays
- Backend fetch with 5-second timeout and error handling
- Load pricing data (await `fetchPricing`) before local cost computation

### `src/cli/index.ts` — Update

- Add `--today` option to the `report` command definition

### `src/transport/local.ts` — No changes needed

- `ledger.read()` returns all events (up to 7 days), caller filters by date. Same pattern as ticker seeding.

## Edge Cases

- **No ledger file:** show "No cost data yet" message
- **Ledger has events but pricing not loaded:** show call-count-only format
- **Backend returns error/timeout:** silently fall back to local data, no error shown to user
- **Backend returns partial data:** use whatever it returns (byDay might be empty for new accounts)
- **Mix of priced and unpriced services:** only show priced services in cost summary, mention unpriced count: `+ 3 services not priced`
- **Single day of data in 7-day view:** show summary + one-line daily section
- **`--today` with no calls today:** show "No calls today" message
- **Very large costs ($100+):** format as `$123.45` (2 decimal places). Small costs use more precision per existing `formatCost`.
