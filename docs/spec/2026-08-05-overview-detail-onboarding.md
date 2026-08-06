# Overview, Entity Drill-Down, and Onboarding

## Purpose

Redesign the CLI's Overview tab and empty state. Keep the terminal UI local-first, text-only, and useful over SSH. Do not add raster logos or external requests. This document is an implementation handoff; follow it unless a stated requirement conflicts with a test or existing safety constraint.

## Current Code and Constraints

The TUI enters through `packages/cli/src/index.ts` → `tui/run.tsx` → `tui/App.tsx`. `App` owns the active tab, project/service scope, terminal size, and the current request-detail overlay (`selectedRequestId`). It currently polls scoped `query.dbStats` every second and renders `Onboarding` whenever `stats.requestCount === 0`. This redesign must add an **unscoped** database count for first-run gating; scoped counts remain for the shell/request count and empty-result messages.

`OverviewScreen` currently lives in `packages/cli/src/tui/screens/Overview.tsx`. It has a local `today`/`7d`/`30d` selector, four cards, and a non-selectable entity table. It calls `query.overview` and `query.entityList` once per second. Reuse `usePoll`, `useTermSize`, `theme`, `TableHeader`, `TableRow`, `colWidths`, `fmtUsd`, and `fmtMs`; do not introduce a second layout or color system.

The core query layer is `packages/core/src/query/index.ts`. `overview()` currently sums every non-null `cost_usd` despite its historical `llmSpend30d` name; the new LLM-spend metric must instead explicitly filter `entity_class = 'llm'`. `entityList()` groups only by `entity` and `entity_class`, which is the correct starting granularity for Overview rows. `traces()` already uses keyset pagination (`beforeId`, `LIMIT`) and is the pattern to reuse. `LogsScreen` is the reference implementation for 50-row paging, cursor-following viewport logic, and loading older pages.

The `requests` table has `project_id`, `service`, `entity`, `entity_class`, `provider`, `model`, `normalized_endpoint`, `status`, `started_at`, `latency_ms`, token columns, and `cost_usd`. Existing indexes include project/time, entity/time, provider/model, and time. Add a migration/index only if profiling or the new detail query requires it. If needed, it must match the chronological detail cursor: `(project_id, entity, model, started_at DESC, id DESC)`.

All failures mean `status >= 400 OR status IS NULL`. A `NULL` cost is unknown/unpriced, not free; render `—`, never `$0.00`. The same rule applies to unknown latency and token/byte values. Keep payload reads lazy: `query.requestDetail()` is called only after a user opens an individual request.

## Overview Layout

The shell, tabs, project/service controls, and footer remain in `App`. The Overview content is:

```text
WINDOW  Today   7d   [30d]

LLM ACTIVITY
[ LLM spend ] [ Most expensive LLM ] [ LLM calls ] [ Tokens ]

API HEALTH
[ API calls  ] [ Most used API      ] [ Failed requests ] [ API P95 ]

AI PROVIDERS
KIND  PROVIDER / SERVICE   COST   CALLS   ERR   P95
◆     OpenAI               $…      …       …      …

API SERVICES
◇     Stripe                 —      …       …      …
```

On a wide terminal, render four cards in each row. On medium/narrow terminals, render two cards per row. In the table, hide `P95` first and then `ERR`; never hide provider/service, cost, or calls. Do not show tokens or data-volume beneath the cost in Overview rows.

Use exactly two stable glyphs for now: `◆` for LLM/AI and `◇` for general API. Do not use provider initials, emoji, raster logos, or Logo.dev. The project already defines compatible LLM/API glyphs in `packages/cli/src/tui/glyphs.ts`.

Use orange only for burn0 branding, section headings, active tab/window, and focused controls. Row selection is a subdued full-row inverse/background treatment, not an orange left rail. Cards are informational and are never focusable or drill-down targets.

## Eight Cards

Every card uses the selected window and active project/service scope.

| Group | Card | Definition |
|---|---|---|
| LLM | LLM Spend | Sum known `cost_usd` for LLM requests. Render `—` if the selected window has LLM calls but no known prices. |
| LLM | Most Expensive LLM | Provider/model pair with the greatest known LLM cost; show pair, spend, and share of known LLM spend. Use `—` / `No priced model` if none is priced. |
| LLM | LLM Calls | Count requests where `entity_class = 'llm'`. |
| LLM | Tokens | Sum LLM token usage. A compact total is sufficient on Overview; input/output detail belongs below the next drill-down level. Render `—` if no selected calls reported usage. |
| API | API Calls | Count requests where `entity_class != 'llm'`. |
| API | Most Used API | General-API entity with the highest request count; show name, calls, and share of API calls. |
| API | Failed API Requests | Count and rate of general-API requests whose status is `>= 400` or `NULL`. |
| API | API P95 Latency | 95th percentile of non-null general-API `latency_ms`; render `—` if no latency is known. |

Use a single typed core query such as `query.overviewDashboard(db, { now, windowDays, scope })` rather than eight independent UI queries. Return typed fields; do not use `any` in the new screen. It is acceptable for the query implementation to make several indexed SQL statements. SQLite has no built-in percentile aggregate, so compute P95 deliberately and test the definition. Do not call it an average.

### Calculation contract

All cards and rows must use the same immutable query inputs for one refresh:

```ts
const now = Date.now()
const windowStart = windowDays === 0
  ? startOfLocalDay(now)
  : now - windowDays * 86_400_000
```

`today` means local midnight through now, matching the existing `startOfToday()` behavior in `core/query`. `7d` and `30d` are rolling 7 × 24-hour and 30 × 24-hour windows, matching the current `windowStart()` behavior. Every SQL statement also receives the existing `Scope` predicate: `project_id IN (...)` when a project is selected and `service IN (...)` when a service is selected. An empty scope array must still compile to `0=1`, never to all projects.

For each request in the selected time window and scope, classify it once:

```ts
const isLlm = row.entityClass === 'llm'
const isApi = !isLlm
const isFailure = row.status == null || row.status >= 400
const hasKnownPrice = row.costUsd != null
const hasKnownLatency = row.latencyMs != null
const hasTokenUsage = row.tokensIn != null || row.tokensOut != null
```

The metric calculations are exact:

```text
LLM calls              count(isLlm)
LLM known spend        sum(costUsd for isLlm && hasKnownPrice)
LLM priced calls       count(isLlm && hasKnownPrice)
LLM tokens             sum((tokensIn ?? 0) + (tokensOut ?? 0) for isLlm && hasTokenUsage)
LLM token-reporting    count(isLlm && hasTokenUsage)

API calls              count(isApi)
Failed API requests    count(isApi && isFailure)
API error rate         failed API requests / API calls
API P95 latency        nearest-rank P95 over latencyMs for isApi && hasKnownLatency
```

`Most Expensive LLM` groups known-price LLM requests by `(entity, provider, model)`. Exclude `model IS NULL` from this card; show `No priced model` if no group remains. Its percentage is `selectedGroupKnownSpend / totalKnownLlmSpend`, not a percentage of potentially unknown spend.

`Most Used API` groups API requests by `entity`, selects the greatest call count, and calculates its share as `entityCalls / totalApiCalls`.

For an Overview entity row, group by `(entity, entity_class)` and calculate calls, errors, error rate, and P95 using that group. LLM row cost is the sum of known prices only. API cost always renders `—` in this scope even if a future row happens to contain a non-LLM price; general API pricing is explicitly out of scope for this screen.

### Display rules for incomplete data

Never manufacture a zero:

| Situation | Card or row display |
|---|---|
| No LLM calls | `—` with `No LLM requests` |
| LLM calls, zero priced calls | `—` with `No priced calls` |
| Some, but not all, LLM calls priced | Show known spend and `priced X/Y calls` as the muted detail text |
| No token-reporting LLM calls | `—` with `No token usage reported` |
| No API calls | `—` with `No API requests` |
| No known API latency | `—` with `No latency reported` |
| API calls with zero failures | `0` with `No failed requests` |

The cards may use a muted second line for the coverage text above. Do not put coverage, tokens, or byte volume into the Overview rows.

### Core query skeleton

Add the following shapes to `packages/core/src/query/index.ts` (exact names may differ, but retain the separation and null semantics):

```ts
export type WindowDays = 0 | 7 | 30

export interface OverviewDashboard {
  llmSpendUsd: number | null
  llmCalls: number
  llmPricedCalls: number
  tokens: number | null
  llmTokenReportingCalls: number
  mostExpensiveModel: { entity: string; provider: string | null; model: string; costUsd: number; share: number } | null
  apiCalls: number
  mostUsedApi: { entity: string; calls: number; share: number } | null
  failedApiCalls: number
  apiErrorRate: number | null
  apiP95LatencyMs: number | null
}

export interface OverviewEntityRow {
  entity: string
  entityClass: 'llm' | 'general'
  calls: number
  costUsd: number | null // null when no call in the group has a known price
  errors: number
  errorRate: number
  p95LatencyMs: number | null
}

export function overviewDashboard(
  db: StorageDriver,
  opts: { now?: number; windowDays?: WindowDays; scope?: Scope | null } = {},
): OverviewDashboard

export function overviewEntities(
  db: StorageDriver,
  opts: { now?: number; windowDays?: WindowDays; scope?: Scope | null } = {},
): OverviewEntityRow[]
```

Build every predicate from the existing `scopeSql` convention and a fixed time predicate. Do not interpolate entity/model values into SQL. The LLM spend/count query must include `entity_class = 'llm'`; the API queries must include `entity_class != 'llm'`.

The overview entity SQL should preserve unknown pricing rather than flattening it to zero:

```sql
SELECT entity,
       entity_class AS entityClass,
       COUNT(*) AS calls,
       SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END) AS errors,
       SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS pricedCalls,
       SUM(cost_usd) AS costUsd
FROM requests
WHERE started_at >= ? AND /* scope predicate */
GROUP BY entity, entity_class
```

Map `pricedCalls === 0` to `costUsd: null`; otherwise preserve the returned sum. Sort LLM entities by `costUsd ?? -1` descending, then calls descending, then entity ascending. Sort API entities by calls descending, then entity ascending. This keeps unpriced rows deterministic.

For the one scalar API-P95 card, first count non-null latency values with the same predicate. If count is zero, return `null`. Otherwise select the value at `Math.ceil(count * 0.95) - 1` from `ORDER BY latency_ms ASC`. A single `OFFSET` is acceptable for this scalar percentile calculation; **never** use `OFFSET` for paging the request list. A live insert between the count and selection can move one displayed percentile by one rank for one refresh; this is harmless for the dashboard and converges on the next poll.

For grouped P95 values (Overview entity rows, LLM model rows, and API endpoint rows), use one SQLite window-function query rather than a count/offset query for every group:

```sql
WITH latency_rank AS (
  SELECT entity,
         entity_class,
         latency_ms,
         ROW_NUMBER() OVER (
           PARTITION BY entity, entity_class
           ORDER BY latency_ms ASC
         ) AS position,
         COUNT(*) OVER (
           PARTITION BY entity, entity_class
         ) AS total
  FROM requests
  WHERE started_at >= ?
    AND latency_ms IS NOT NULL
    AND /* scope predicate */
)
SELECT entity, entity_class, latency_ms AS p95LatencyMs
FROM latency_rank
WHERE position = CAST((total * 95 + 99) / 100 AS INTEGER)
```

Use equivalent partition keys for models (`entity, provider, model`) and endpoints (`entity, method, normalized_endpoint`). Join or map these results into the aggregate rows. This avoids N+1 queries and must not be replaced by `AVG(latency_ms)`.

## Scrollable Rows

The two labeled groups are one scrollable list with one table header and one cursor; they are not two panels. LLM rows are sorted by known cost descending (unpriced LLM rows follow). API rows are sorted by call count descending. Each Overview row is one **entity/provider**, not one model or endpoint:

```text
◆ OpenAI      $14.20   620   0.4%   1.10s
◇ Stripe        —      892   2.6%    310ms
```

This prevents an OpenAI customer using five models from seeing five repetitive rows. Enter opens the entity; models/endpoints are revealed inside the entity view.

The row viewport is height-bound. `↓` enters/moves through it; `↑/↓` changes the row; `Page Up/Page Down` moves by a viewport; the table header remains visible. Enter is the only Overview drill-down action. Preserve the current window, scope, selected row, and list scroll position when returning with Escape.

## Entity and Target Drill-Down

Add an explicit TUI route/view state in `App`; do not overload `selectedRequestId`, which is reserved for `DebugScreen`. A route shape such as `overview | entity-detail | target-detail | request-detail` is acceptable. Escape moves one level back and restores the saved parent state.

### Route and component skeleton

Keep the shell in `App.tsx`, but replace the single `selectedRequestId` branch with a discriminated route. This makes parent restoration explicit:

```tsx
interface OverviewReturnState {
  tab: number
  windowDays: WindowDays
  selectedEntity: { entity: string; entityClass: 'llm' | 'general' } | null
  fallbackCursor: number
  scroll: number
}

interface EntityReturnState {
  entity: string
  entityClass: 'llm' | 'general'
  selectedTarget: { model?: string; method?: string; endpoint?: string } | null
  fallbackCursor: number
  scroll: number
}

type TuiRoute =
  | { kind: 'dashboard'; restore?: OverviewReturnState }
  | { kind: 'entity'; entity: string; entityClass: 'llm' | 'general'; returnTo: OverviewReturnState }
  | { kind: 'target'; entity: string; entityClass: 'llm' | 'general'; target: { model?: string; method?: string; endpoint?: string }; returnTo: EntityReturnState }
  | { kind: 'request'; requestId: number; returnTo: Exclude<TuiRoute, { kind: 'request' }> }

const [route, setRoute] = useState<TuiRoute>({ kind: 'dashboard' })
```

`OverviewScreen` receives `onOpenEntity(row, state)` and calls it only for Enter on a selected row. It does not receive an `onOpen` handler for metric cards. Store stable entity/target keys, not an `OverviewEntityRow` snapshot: detail headers must query fresh data on render. On return, find the stored key in the refreshed list and use `fallbackCursor` only if the entity/target disappeared. New screens should be focused files:

```text
packages/cli/src/tui/screens/Overview.tsx
packages/cli/src/tui/screens/EntityDetail.tsx
packages/cli/src/tui/screens/TargetDetail.tsx
packages/cli/src/tui/screens/Onboarding.tsx
```

Use `DebugScreen` unchanged as the leaf request view. Escape from `request` restores `returnTo`; Escape from target restores the entity target cursor/scroll; Escape from entity restores the Overview selected entity/cursor/scroll/window.

### Entity detail (opened from Overview)

The header is `Overview / OpenAI` or `Overview / Stripe`, includes the current window, and retains project/service scope.

- LLM entity detail: show aggregate spend, calls, failures/rate, and P95 latency, followed by a selectable **Models** table. Each model row includes model name, cost, calls, error rate, and P95.
- API entity detail: show aggregate calls, failures/rate, and P95 latency, followed by a selectable **Endpoints** table. Each endpoint row includes method + normalized endpoint, calls, error rate, and P95. Cost remains `—` unless reliable general-API pricing exists.

The child table is paginated only when needed. Enter on a model/endpoint opens target detail.

### Target detail (opened from model/endpoint)

The target page is the request-list view previously mocked as `OpenAI · GPT-4.1`. Show a breadcrumb, selected window, four compact target metrics, and a table labeled `REQUESTS (count)`:

```text
TIME      STATUS   ROUTE                 COST       LATENCY
14:02:07  200      POST /api/chat        $0.0142      820ms
```

The selected window means all matching requests, not merely a few “recent” records. Render the terminal-height viewport only. Fetch 50 records at a time in newest-first order; fetch another page as the cursor nears the end. Use keyset pagination, not `OFFSET`. A 40,000-request target window must remain usable because the UI never queries, stores in React state, or renders all rows at once. Enter opens the existing `DebugScreen` for that request.

Add core query functions/types for entity summary, entity targets, and target requests. They must accept `now`, `windowDays`, and `scope`, and must apply all filters in SQL. The existing `traces()` function does not yet support time windows or model filters, so do not bend it into an ambiguous interface if a focused request-list query is clearer.

### Detail query and paging skeleton

Use a single filter object in new detail queries so the summary, target table, and request pages cannot disagree:

```ts
export interface DetailFilter {
  entity: string
  entityClass: 'llm' | 'general'
  model?: string
  method?: string
  endpoint?: string
  now?: number
  windowDays?: WindowDays
  scope?: Scope | null
}

export interface DetailRequestRow {
  id: number
  startedAt: number
  status: number | null
  method: string
  normalizedEndpoint: string
  costUsd: number | null
  latencyMs: number | null
}

export function detailRequestPage(
  db: StorageDriver,
  filter: DetailFilter & { beforeStartedAt?: number; beforeId?: number; limit?: number },
): DetailRequestRow[]
```

For LLM targets add `AND r.model = ?`. For API targets add `AND r.method = ? AND r.normalized_endpoint = ?`. Never parse a display string such as `POST /emails` back into fields. The request page SQL follows the established Logs pattern, but sorts by actual capture time with ID as the stable tie-breaker:

```sql
SELECT r.id, r.started_at AS startedAt, r.status, r.method,
       r.normalized_endpoint AS normalizedEndpoint,
       r.cost_usd AS costUsd, r.latency_ms AS latencyMs
FROM requests r
WHERE /* detail + time + scope predicates */
  AND (
    ? IS NULL
    OR r.started_at < ?
    OR (r.started_at = ? AND r.id < ?)
  )
ORDER BY r.started_at DESC, r.id DESC
LIMIT ?
```

The page cursor is `{ beforeStartedAt, beforeId }`. In the screen, use `const PAGE = 50` and `const PREFETCH = 5`, mirroring `LogsScreen`. Keep an appended page buffer, de-duplicate by ID, and render only `rows.slice(start, start + maxRows)`. Do not poll/rebuild the entire buffer every second; re-query the first page on filter/window changes and optionally poll it for new matching records.

## Empty States

Keep these states distinct:

1. **No requests anywhere in the database:** replace the old minimal `Onboarding` in `App.tsx` with the first-run screen below. This decision uses `query.dbStats(db)` with no scope, not the current project/service-scoped count.
2. **Requests exist, but none in the selected window:** keep Overview chrome and window picker; show `No requests in 7d — try 30d.` Do not show onboarding.
3. **API-only or LLM-only window:** keep all eight cards. The absent group shows `—` and a short `No LLM requests`/`No API requests` subtitle; only render rows for the present group.
4. **No priced LLM calls:** spend and expensive-model metrics show `—`, never a zero dollar amount.
5. **No API failures:** show `0` and `No failed requests` neutrally, not as an error state.

## First-Run Onboarding

Replace the current `Onboarding` component in `packages/cli/src/tui/App.tsx`. It currently says `No requests captured yet` and presents three plain numbered lines. The new first-run screen is calm, centered, and uses the existing burn-orange/monospace design language:

```text
burn0                                      Local API and LLM observability

FIRST RUN
Your API activity will appear here.

burn0 watches outbound requests while your application runs.
Everything stays on your machine—no account, proxy, or cloud dashboard.

Run your application and make an API or LLM request.
burn0 will refresh automatically when activity is captured.

Not seeing activity? Press ? for setup help.
```

Do not make `import 'burn0'` a prominent default step. It is technically required today (or `node --import burn0/register`) for instrumentation to be installed, but it is troubleshooting/setup information. Bind `?` to a compact setup-help view/section that shows Node and Bun activation commands. Do not claim that burn0 can observe an arbitrary process it was not loaded into.

The setup-help body may use these exact, current activation methods:

```text
Node.js: import 'burn0'
Node.js: node --import burn0/register app.js
Bun:     bun --import burn0/register src/index.ts
```

## Tests and Verification

Add focused Vitest/Ink tests alongside the existing CLI tests:

- Core query tests: all eight metric definitions, LLM-vs-API separation, scope/window filtering, NULL status failures, NULL price display data, stable P95, entity aggregation across multiple OpenAI models, and pagination without duplicates/skips.
- Overview tests: eight labels, selected-window updates, mixed grouped rows, keyboard selection, Enter callback only from a row, narrow-column fallback, and each empty state.
- Entity/target tests: model/endpoint grouping, current window propagation, Escape restoration, 50-row paging, and opening the correct request ID.
- Onboarding tests: empty database shows the new screen; `?` reveals activation help.
- First-run gate tests: a globally populated database with an empty selected project/service must render the scoped-empty Overview state, never full onboarding.

Suggested test shapes:

```ts
it('aggregates five OpenAI models into one Overview entity row', () => {
  // seed five `entity: OpenAI`, `entityClass: llm` requests with distinct models
  // expect one OpenAI overview row whose calls/cost are the sums
})

it('keeps null pricing distinct from a free-looking zero', () => {
  // seed LLM calls with costUsd: null
  // expect dashboard.llmSpendUsd toBeNull()
})

it('loads the next 50 target requests without duplicate IDs', () => {
  // seed 101 matching requests; page with beforeStartedAt/beforeId from the final first-page row
  // expect 50 older distinct IDs, then one final row
})
```

Run from `burn0-1/`:

```bash
pnpm --filter @burn0/core test
pnpm --filter @burn0/cli test
pnpm --filter @burn0/core lint
pnpm --filter @burn0/cli lint
pnpm test
```

Do not modify capture behavior, pricing logic, or payload retention as part of this UI work.
