# Live Cost Ticker — Design Spec

## Problem

burn0's terminal output is a scrolling table on stdout that interleaves with app output, resets on process restart, and shows rows of data nobody reads. It feels like a debug log, not a product. For long-running servers, "session total" is meaningless.

## Solution

Replace the scrolling table with a single self-updating line on stderr that shows today's cumulative cost.

## Live Line Format

```
burn0 ▸ $4.32 today (47 calls) ── openai: $3.80 · anthropic: $0.52
```

- Overwrites itself using `\x1b[2K\r` on stderr (clear entire line + carriage return, avoids artifacts when line shrinks)
- Shows today's cumulative cost (loaded from local ledger on startup + new calls in this process)
- Breaks down cost by service name (`event.service`, e.g. "openai", "anthropic"), sorted by cost descending
- Uses ANSI colors: burn0 brand orange for "burn0 ▸", green for costs, dim/gray for separators
- Updates on every intercepted API call
- Only renders when `process.stderr.isTTY` is true (piped/CI gets no output)

## Exit Summary

On process exit (SIGINT, SIGTERM, SIGHUP, beforeExit), print a final line to stderr:

```
burn0 ▸ session: $0.47 (12 calls, 4m 22s) ── today: $14.32
```

- Prints a newline first (to preserve the last live ticker line), then the exit summary
- Session cost: sum of costs from calls made during this process run
- Session duration: time since burn0 was loaded
- Today total: full day's cost including prior runs (from ledger)
- Idempotent: prints at most once (guard flag), handles repeated signals (e.g. double Ctrl+C)
- After printing, the handler removes itself and re-emits the signal (`process.kill(process.pid, signal)`) so the default behavior (termination) still occurs. For `beforeExit`, no re-emit needed — the process exits naturally.

## TTY Behavior

| `process.stderr.isTTY` | Live line | Exit summary |
|---|---|---|
| true (terminal) | Yes, self-updating | Yes, one line |
| false (piped/CI) | No output | No output |

This is independent of the existing `isTTY()` in `config/env.ts` which checks `stdout.isTTY` for mode detection. The ticker has its own stderr TTY check.

## Mode and Dispatcher Changes

The current dispatcher only calls `logEvent` in `dev-local`, `dev-cloud`, and `test-enabled` modes. The ticker replaces `logEvent` and should fire in **all modes except `test-disabled`**:

| Mode | Ticker (stderr) | Ledger write | Batch ship |
|---|---|---|---|
| `dev-local` | Yes (if TTY) | Yes | No |
| `dev-cloud` | Yes (if TTY) | No | Yes |
| `prod-cloud` | Yes (if TTY) | No | Yes |
| `prod-local` | Yes (if TTY) | No | No |
| `test-enabled` | Yes (if TTY) | Yes | Yes |
| `test-disabled` | No | No | No |

The ticker itself gates on `stderr.isTTY`, so in prod where stderr is usually piped, no output appears. But if someone runs a prod process in a terminal, they see costs.

The existing `formatProcessSummary()` (JSON output for `prod-local` on `beforeExit`) is **removed**. The ticker's exit summary replaces it.

## Data Flow

1. On startup, create a `LocalLedger` instance (in all modes, not just `dev-local`) and read today's events by filtering `ledger.read()` for entries where `event.timestamp` starts with today's date string (local timezone, `YYYY-MM-DD` format)
2. Sum today's prior costs using `estimateLocalCost()` per event, build per-service cost map
3. Pass prior state to `createTicker({ todayCost, todayCalls, perServiceCosts })`
4. On each intercepted API call, `ticker.tick(event)` estimates cost, updates totals, re-renders
5. On exit, `ticker.printExitSummary()` prints the session + today summary

## `createTicker()` Interface

```typescript
interface TickerInit {
  todayCost: number
  todayCalls: number
  perServiceCosts: Record<string, number>  // service name → cost
}

interface Ticker {
  tick: (event: Burn0Event) => void
  printExitSummary: () => void
}

function createTicker(init: TickerInit): Ticker
```

The ticker internally tracks:
- `sessionCost`, `sessionCalls`, `sessionStartTime` (this process only)
- `todayCost`, `todayCalls`, `perServiceCosts` (today cumulative, seeded from `init`)

## Files to Change

### `src/transport/logger.ts` — Rewrite

Remove:
- `printHeader()`, `printSessionTotal()`, `formatEventLine()`, `logEvent()`, `formatProcessSummary()`
- All module-level mutable state (`headerPrinted`, `sessionTotal`, `eventCount`)

Add:
- `createTicker(init: TickerInit): Ticker` — factory function
- Internal `render()` that writes the single line to stderr
- Internal `printExitSummary()` with idempotent guard
- Helper `formatCost()` (kept from current), `formatServiceBreakdown()`

### `src/index.ts` — Wire up

- Always create a `LocalLedger` (remove the mode check that currently makes it `null` in cloud/prod modes)
- On startup, read today's prior cost from ledger and seed the ticker
- Pass `ticker.tick` as the `logEvent` dependency to the dispatcher
- Update dispatcher to call `logEvent` in `prod-cloud` and `prod-local` modes too (the ticker self-gates on TTY)
- Register `ticker.printExitSummary()` on exit signals (SIGINT, SIGTERM, SIGHUP, beforeExit)
- Remove the `prod-local` `formatProcessSummary` exit handler
- Remove the `accumulatedEvents` array (no longer needed)

### `src/transport/dispatcher.ts` — Update

- Call `logEvent` in all modes except `test-disabled` (add it to `prod-cloud` and `prod-local` cases)
- Remove `accumulate` from `DispatcherDeps` interface — no longer used by any mode
- Remove the `prod-local` → `accumulate` case, replace with `logEvent`

### `tests/transport/logger.test.ts` — Rewrite

- Remove tests for `formatEventLine`, `formatProcessSummary`, `logEvent`
- Add tests for `createTicker`: tick updates totals, exit summary format, TTY gating, idempotent exit, service breakdown truncation

### `tests/transport/dispatcher.test.ts` — Update

- Update expectations for `prod-cloud` and `prod-local` to reflect that `logEvent` is now called

### No changes needed

- `src/transport/local-pricing.ts` — cost estimation logic stays the same
- `src/transport/local.ts` — ledger read/write stays the same (read returns all events, caller filters by date)
- `src/transport/batch.ts` — batch shipping stays the same
- `src/transport/api.ts` — API shipping stays the same
- `src/track.ts` — feature attribution stays the same
- `src/interceptor/*` — interception stays the same
- `src/config/env.ts` — `isTTY()` unchanged (still checks stdout for mode detection)

## Edge Cases

- **No calls made in this session**: no live line rendered. No exit summary printed (nothing to report).
- **No calls today but calls in session**: today total equals session total.
- **Cost estimation returns "unknown"/"loading"**: count the call in `todayCalls`/`sessionCalls`, but do not add to cost totals. Service does not appear in the per-service breakdown (avoids misleading $0.00).
- **Line exceeds terminal width**: show top 3 services by cost, truncate remaining as `+N more`. The total and call count always remain visible.
- **First run (no ledger file)**: `ledger.read()` returns `[]`, today totals start at 0.
- **"Today" boundary**: uses local timezone. Get today's date string via `const today = new Date(); const todayStr = \`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}\``. Compare against each event by converting `new Date(event.timestamp)` to the same local date format. Do NOT use `.toISOString()` as that returns UTC.
- **Ledger not writable** (permissions, read-only fs): ticker still works for session-only data, today total just won't include prior runs.
- **Ledger read-only in cloud/prod modes**: the ledger is created in all modes but only written to in `dev-local` and `test-enabled`. In cloud/prod modes, the "today" total only reflects prior local-mode runs. This is acceptable — cloud-mode users get session-only cost visibility in the terminal, and full historical data via the backend dashboard.
- **Cost estimate types**: `priced` → add to cost totals and per-service breakdown. `free` → count call, don't add cost, don't show in breakdown. `no-tokens` / `fixed-tier` / `unknown` / `loading` → count call but don't add cost, don't show in breakdown.
- **test-enabled mode**: the ledger read on startup is acceptable — test processes are short-lived and the ledger is typically small. No special handling needed.
