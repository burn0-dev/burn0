import type { StorageDriver } from '../storage/driver.js'
import { resolveHost } from '../entities/index.js'

const DAY = 86_400_000

export interface TraceRow {
  id: number; startedAt: number; method: string; entity: string; hostname: string; provider: string | null
  normalizedEndpoint: string; status: number | null; latencyMs: number | null
  reqBytes: number | null; resBytes: number | null
  model: string | null; tokensIn: number | null; tokensOut: number | null
  /** null iff this request never reported cache info — distinct from "0 cached" (spec §1.3). */
  tokensCached: number | null
  costUsd: number | null
  project: string
}

const TRACE_SELECT = `
  SELECT r.id, r.started_at AS startedAt, r.method, r.entity, r.hostname, r.provider,
         r.normalized_endpoint AS normalizedEndpoint, r.status, r.latency_ms AS latencyMs,
         r.req_bytes AS reqBytes, r.res_bytes AS resBytes,
         r.model, r.tokens_in AS tokensIn, r.tokens_out AS tokensOut, r.tokens_cached AS tokensCached,
         r.cost_usd AS costUsd,
         p.name AS project
  FROM requests r JOIN projects p ON p.id = r.project_id`

function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// windowDays 0 means "today" (since local start of day)
function windowStart(now: number, windowDays: number): number {
  return windowDays === 0 ? startOfToday(now) : now - windowDays * DAY
}

/** What a read is allowed to see. `null` on a field means "no restriction".
 *
 *  The time window is deliberately NOT part of this — it is a view control, and
 *  three of the readers below (`traces`, `liveTail`, `dbStats`) have no window at
 *  all. Folding it in would force them to carry a parameter they ignore. */
export interface Scope {
  projectIds: number[] | null
  services: string[] | null
}

/** An *empty* array means "nothing matched" and must return no rows. Widening an
 *  unresolved scope to the whole machine is a caller's decision (§1.4 D2), not a
 *  silent property of the query layer. */
function scopeSql(s: Scope | null | undefined, alias = ''): { sql: string; params: unknown[] } {
  const col = alias ? `${alias}.` : ''
  const parts: string[] = []
  const params: unknown[] = []
  if (s?.projectIds) {
    if (s.projectIds.length === 0) return { sql: '0=1', params: [] }
    parts.push(`${col}project_id IN (${s.projectIds.map(() => '?').join(',')})`)
    params.push(...s.projectIds)
  }
  if (s?.services) {
    if (s.services.length === 0) return { sql: '0=1', params: [] }
    parts.push(`${col}service IN (${s.services.map(() => '?').join(',')})`)
    params.push(...s.services)
  }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params }
}

export function overview(db: StorageDriver, now = Date.now(), windowDays = 30, scope?: Scope | null) {
  const since = windowStart(now, windowDays)
  const { sql, params } = scopeSql(scope)
  const spendSql = `SELECT COALESCE(SUM(cost_usd),0) s FROM requests
                    WHERE cost_usd IS NOT NULL AND started_at >= ? AND ${sql}`
  const spend = db.prepare(spendSql).get(since, ...params).s
  const spendToday = db.prepare(spendSql).get(startOfToday(now), ...params).s
  const agg = db.prepare(
    `SELECT COUNT(*) c,
            COALESCE(AVG(latency_ms),0) l,
            COALESCE(SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END),0) e
     FROM requests WHERE started_at >= ? AND ${sql}`).get(since, ...params)
  return {
    llmSpend30d: spend, llmSpendToday: spendToday,
    totalCalls: agg.c, errorRate: agg.c ? agg.e / agg.c : 0, avgLatencyMs: agg.l,
  }
}

export function entityList(db: StorageDriver, now = Date.now(), windowDays = 30, scope?: Scope | null) {
  const { sql, params } = scopeSql(scope)
  const rows = db.prepare(
    `SELECT entity, entity_class AS entityClass, COUNT(*) calls,
            COALESCE(SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END),0)*1.0/COUNT(*) errorRate,
            COALESCE(AVG(latency_ms),0) avgLatencyMs,
            COALESCE(SUM(cost_usd),0) costUsd
     FROM requests WHERE started_at >= ? AND ${sql} GROUP BY entity, entity_class`)
    .all(windowStart(now, windowDays), ...params)
  const llm = rows.filter((r: any) => r.entityClass === 'llm').sort((a: any, b: any) => b.costUsd - a.costUsd)
  const general = rows.filter((r: any) => r.entityClass !== 'llm').sort((a: any, b: any) => b.calls - a.calls)
  return [...llm, ...general]
}

// ── Overview dashboard (spec 2026-08-05) ────────────────────────────────────

export type WindowDays = 0 | 7 | 30

export interface OverviewDashboard {
  /** null iff no LLM call in the window has a known price — unpriced is not free. */
  llmSpendUsd: number | null
  llmCalls: number
  llmPricedCalls: number
  /** null iff no LLM call reported token usage. */
  tokens: number | null
  llmTokenReportingCalls: number
  mostExpensiveModel: { entity: string; provider: string | null; model: string; costUsd: number; share: number } | null
  apiCalls: number
  mostUsedApi: { entity: string; calls: number; share: number } | null
  failedApiCalls: number
  /** null iff there are no API calls in the window — 0/0 is not a rate. */
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

const FAILURE = `(status >= 400 OR status IS NULL)`

/** Nearest-rank P95 for one predicate. Two statements (count, then offset
 *  select) — a live insert between them can move the result by one rank for
 *  one refresh, which converges on the next poll. OFFSET is acceptable for
 *  this one scalar; never for paging a request list. */
function p95Scalar(db: StorageDriver, where: string, params: unknown[]): number | null {
  const pred = `${where} AND latency_ms IS NOT NULL`
  const n = db.prepare(`SELECT COUNT(*) c FROM requests WHERE ${pred}`).get(...params).c as number
  if (n === 0) return null
  return db.prepare(
    `SELECT latency_ms v FROM requests WHERE ${pred} ORDER BY latency_ms ASC LIMIT 1 OFFSET ?`)
    .get(...params, Math.ceil(n * 0.95) - 1).v as number
}

/** Nearest-rank P95 per group in ONE window-function query — the count/offset
 *  approach would be N+1 over groups. `(total * 95 + 99) / 100` under SQLite
 *  integer division is exactly ceil(0.95 · total) in 1-indexed ROW_NUMBER
 *  terms, matching `p95Scalar`. Keyed by JSON of the partition values so a
 *  NULL model can't collide with a literal "null" string. */
function p95ByGroup(
  db: StorageDriver, cols: string[], where: string, params: unknown[],
): Map<string, number> {
  const list = cols.join(', ')
  const rows = db.prepare(`
    WITH lr AS (
      SELECT ${list}, latency_ms,
             ROW_NUMBER() OVER (PARTITION BY ${list} ORDER BY latency_ms ASC) AS pos,
             COUNT(*) OVER (PARTITION BY ${list}) AS total
      FROM requests
      WHERE ${where} AND latency_ms IS NOT NULL
    )
    SELECT ${list}, latency_ms AS p95 FROM lr
    WHERE pos = (total * 95 + 99) / 100`).all(...params) as any[]
  const out = new Map<string, number>()
  for (const r of rows) out.set(JSON.stringify(cols.map((c) => r[c.split('.').pop()!.trim()] ?? null)), r.p95)
  return out
}

/** One immutable (time, scope) predicate shared by every statement of a
 *  single refresh, so no card can disagree with another about the window. */
function windowScope(
  opts: { now?: number; windowDays?: WindowDays; scope?: Scope | null },
): { now: number; sql: string; params: unknown[] } {
  const now = opts.now ?? Date.now()
  const s = scopeSql(opts.scope)
  return {
    now,
    sql: `started_at >= ? AND ${s.sql}`,
    params: [windowStart(now, opts.windowDays ?? 30), ...s.params],
  }
}

export function overviewDashboard(
  db: StorageDriver,
  opts: { now?: number; windowDays?: WindowDays; scope?: Scope | null } = {},
): OverviewDashboard {
  const { sql, params } = windowScope(opts)
  const llmWhere = `entity_class = 'llm' AND ${sql}`
  const apiWhere = `entity_class != 'llm' AND ${sql}`

  const llm = db.prepare(
    `SELECT COUNT(*) calls,
            COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END),0) priced,
            SUM(cost_usd) spend,
            COALESCE(SUM(CASE WHEN tokens_in IS NOT NULL OR tokens_out IS NOT NULL THEN 1 ELSE 0 END),0) tokenCalls,
            COALESCE(SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)),0) tokens
     FROM requests WHERE ${llmWhere}`).get(...params)

  // Known-price spend by (entity, provider, model); NULL model is excluded from
  // this card by spec — a price with no model is not a "most expensive model".
  const top = db.prepare(
    `SELECT entity, provider, model, SUM(cost_usd) costUsd
     FROM requests
     WHERE ${llmWhere} AND cost_usd IS NOT NULL AND model IS NOT NULL
     GROUP BY entity, provider, model
     ORDER BY costUsd DESC, entity ASC, model ASC LIMIT 1`).get(...params)

  const api = db.prepare(
    `SELECT COUNT(*) calls,
            COALESCE(SUM(CASE WHEN ${FAILURE} THEN 1 ELSE 0 END),0) failed
     FROM requests WHERE ${apiWhere}`).get(...params)

  const topApi = db.prepare(
    `SELECT entity, COUNT(*) calls FROM requests WHERE ${apiWhere}
     GROUP BY entity ORDER BY calls DESC, entity ASC LIMIT 1`).get(...params)

  const llmSpendUsd = llm.priced === 0 ? null : llm.spend as number
  return {
    llmSpendUsd,
    llmCalls: llm.calls,
    llmPricedCalls: llm.priced,
    tokens: llm.tokenCalls === 0 ? null : llm.tokens,
    llmTokenReportingCalls: llm.tokenCalls,
    mostExpensiveModel: top
      ? {
          entity: top.entity, provider: top.provider ?? null, model: top.model, costUsd: top.costUsd,
          // Share of KNOWN spend — a percentage of unknown spend would be fiction.
          share: llmSpendUsd ? top.costUsd / llmSpendUsd : 0,
        }
      : null,
    apiCalls: api.calls,
    mostUsedApi: topApi ? { entity: topApi.entity, calls: topApi.calls, share: topApi.calls / api.calls } : null,
    failedApiCalls: api.failed,
    apiErrorRate: api.calls === 0 ? null : api.failed / api.calls,
    apiP95LatencyMs: p95Scalar(db, apiWhere, params),
  }
}

export function overviewEntities(
  db: StorageDriver,
  opts: { now?: number; windowDays?: WindowDays; scope?: Scope | null } = {},
): OverviewEntityRow[] {
  const { sql, params } = windowScope(opts)
  const rows = db.prepare(
    `SELECT entity, entity_class AS entityClass, COUNT(*) AS calls,
            SUM(CASE WHEN ${FAILURE} THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS pricedCalls,
            SUM(cost_usd) AS costUsd
     FROM requests WHERE ${sql}
     GROUP BY entity, entity_class`).all(...params) as any[]

  const p95 = p95ByGroup(db, ['entity', 'entity_class'], sql, params)
  const mapped: OverviewEntityRow[] = rows.map((r) => ({
    entity: r.entity,
    entityClass: r.entityClass,
    calls: r.calls,
    costUsd: r.pricedCalls === 0 ? null : r.costUsd,
    errors: r.errors,
    errorRate: r.errors / r.calls,
    p95LatencyMs: p95.get(JSON.stringify([r.entity, r.entityClass])) ?? null,
  }))

  const byEntity = (a: OverviewEntityRow, b: OverviewEntityRow) => a.entity.localeCompare(b.entity)
  const llm = mapped.filter((r) => r.entityClass === 'llm').sort((a, b) =>
    (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.calls - a.calls || byEntity(a, b))
  const general = mapped.filter((r) => r.entityClass !== 'llm').sort((a, b) =>
    b.calls - a.calls || byEntity(a, b))
  return [...llm, ...general]
}

// ── Entity / target drill-down (spec 2026-08-05) ────────────────────────────

/** One filter shared by summary, target table, and request pages, so the three
 *  views of one drill-down can never disagree about what is in scope.
 *  `model: null` means "model IS NULL" (an LLM target whose model was never
 *  parsed); `model: undefined` means no model filter. */
export interface DetailFilter {
  entity: string
  entityClass: 'llm' | 'general'
  model?: string | null
  method?: string
  endpoint?: string
  now?: number
  windowDays?: WindowDays
  scope?: Scope | null
}

export interface DetailSummary {
  calls: number
  pricedCalls: number
  costUsd: number | null
  errors: number
  errorRate: number | null
  p95LatencyMs: number | null
  tokens: number | null
  tokenReportingCalls: number
}

export interface EntityTargetRow {
  /** LLM rows: the model (null = calls whose model was never parsed). */
  model: string | null
  /** API rows: method + normalized endpoint. */
  method: string | null
  endpoint: string | null
  calls: number
  costUsd: number | null
  errors: number
  errorRate: number
  p95LatencyMs: number | null
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

/** Values are always bound (`?`), never interpolated. */
function detailSql(f: DetailFilter): { sql: string; params: unknown[] } {
  const ws = windowScope(f)
  const parts = [f.entityClass === 'llm' ? `entity_class = 'llm'` : `entity_class != 'llm'`, `entity = ?`]
  const p: unknown[] = [f.entity]
  if (f.model !== undefined) {
    if (f.model === null) parts.push(`model IS NULL`)
    else { parts.push(`model = ?`); p.push(f.model) }
  }
  if (f.method !== undefined && f.endpoint !== undefined) {
    parts.push(`method = ? AND normalized_endpoint = ?`)
    p.push(f.method, f.endpoint)
  }
  parts.push(ws.sql)
  p.push(...ws.params)
  return { sql: parts.join(' AND '), params: p }
}

export function detailSummary(db: StorageDriver, filter: DetailFilter): DetailSummary {
  const { sql, params } = detailSql(filter)
  const agg = db.prepare(
    `SELECT COUNT(*) calls,
            COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END),0) priced,
            SUM(cost_usd) spend,
            COALESCE(SUM(CASE WHEN ${FAILURE} THEN 1 ELSE 0 END),0) errors,
            COALESCE(SUM(CASE WHEN tokens_in IS NOT NULL OR tokens_out IS NOT NULL THEN 1 ELSE 0 END),0) tokenCalls,
            COALESCE(SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)),0) tokens
     FROM requests WHERE ${sql}`).get(...params)
  return {
    calls: agg.calls,
    pricedCalls: agg.priced,
    costUsd: agg.priced === 0 ? null : agg.spend,
    errors: agg.errors,
    errorRate: agg.calls === 0 ? null : agg.errors / agg.calls,
    p95LatencyMs: p95Scalar(db, sql, params),
    tokens: agg.tokenCalls === 0 ? null : agg.tokens,
    tokenReportingCalls: agg.tokenCalls,
  }
}

/** Child rows of an entity: models for an LLM entity, method+endpoint pairs
 *  for an API one. Bounded cardinality — no paging here. */
export function entityTargets(db: StorageDriver, filter: DetailFilter): EntityTargetRow[] {
  const { sql, params } = detailSql(filter)
  const llm = filter.entityClass === 'llm'
  const groupCols = llm ? ['model'] : ['method', 'normalized_endpoint']
  const list = groupCols.join(', ')
  const rows = db.prepare(
    `SELECT ${list}, COUNT(*) calls,
            SUM(CASE WHEN ${FAILURE} THEN 1 ELSE 0 END) errors,
            SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) pricedCalls,
            SUM(cost_usd) costUsd
     FROM requests WHERE ${sql} GROUP BY ${list}`).all(...params) as any[]

  const p95 = p95ByGroup(db, groupCols, sql, params)
  const mapped: EntityTargetRow[] = rows.map((r) => ({
    model: llm ? r.model ?? null : null,
    method: llm ? null : r.method,
    endpoint: llm ? null : r.normalized_endpoint,
    calls: r.calls,
    costUsd: r.pricedCalls === 0 ? null : r.costUsd,
    errors: r.errors,
    errorRate: r.errors / r.calls,
    p95LatencyMs: p95.get(JSON.stringify(groupCols.map((c) => r[c] ?? null))) ?? null,
  }))
  return llm
    ? mapped.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.calls - a.calls
        || (a.model ?? '').localeCompare(b.model ?? ''))
    : mapped.sort((a, b) => b.calls - a.calls
        || `${a.method} ${a.endpoint}`.localeCompare(`${b.method} ${b.endpoint}`))
}

/** One page of a target's requests, newest first. Keyset cursor over
 *  (started_at, id) — never OFFSET — so a 40k-request window stays usable. */
export function detailRequestPage(
  db: StorageDriver,
  filter: DetailFilter & { beforeStartedAt?: number; beforeId?: number; limit?: number },
): DetailRequestRow[] {
  const { sql, params } = detailSql(filter)
  const hasCursor = filter.beforeStartedAt != null && filter.beforeId != null
  const cursor = hasCursor ? ` AND (started_at < ? OR (started_at = ? AND id < ?))` : ''
  const cursorParams = hasCursor
    ? [filter.beforeStartedAt, filter.beforeStartedAt, filter.beforeId]
    : []
  return db.prepare(
    `SELECT id, started_at AS startedAt, status, method,
            normalized_endpoint AS normalizedEndpoint,
            cost_usd AS costUsd, latency_ms AS latencyMs
     FROM requests WHERE ${sql}${cursor}
     ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(...params, ...cursorParams, filter.limit ?? 50) as DetailRequestRow[]
}

export interface UsageRow {
  hostname: string
  method: string
  endpoint: string
  calls: number
  errors: number
  bytesIn: number
  bytesOut: number
  /** Calls whose byte volume was actually measured. 0 means "unknown" — the undici
   *  DC path sees metadata only, and a displayed 0 would claim nothing transferred. */
  bytesInKnown: number
  bytesOutKnown: number
  tokensIn: number
  tokensOut: number
  /** Sum of cache-read tokens. null iff none of the group's calls reported cache
   *  info — distinct from "0 cached", which the UI's `↺` glyph must never imply
   *  for an unknown value (spec §1.3). */
  tokensCached: number | null
  /** Calls that reported token usage. 0 means the provider returned no usage block. */
  tokenCalls: number
  costUsd: number
  /** Calls that resolved to a real price. 0 means "unpriced" — the UI must render
   *  a gap, not $0.00, since SUM over NULLs is indistinguishable from genuinely free. */
  pricedCalls: number
  avgLatencyMs: number
}

/** Leaf rows for the usage tree. Grouped by method AND endpoint: `POST /emails`
 *  sends mail and costs money, `GET /emails` lists it and does not — collapsing
 *  them would merge a billable action with a free one. */
export function usageRows(
  db: StorageDriver, opts: { now?: number; windowDays?: number; scope?: Scope | null } = {},
): UsageRow[] {
  const now = opts.now ?? Date.now()
  const since = windowStart(now, opts.windowDays ?? 30)
  const { sql, params } = scopeSql(opts.scope)
  return db.prepare(
    `SELECT hostname, method, normalized_endpoint AS endpoint,
            COUNT(*) calls,
            COALESCE(SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END),0) errors,
            COALESCE(SUM(req_bytes),0) bytesIn, COALESCE(SUM(res_bytes),0) bytesOut,
            COALESCE(SUM(CASE WHEN req_bytes IS NOT NULL THEN 1 ELSE 0 END),0) bytesInKnown,
            COALESCE(SUM(CASE WHEN res_bytes IS NOT NULL THEN 1 ELSE 0 END),0) bytesOutKnown,
            COALESCE(SUM(tokens_in),0) tokensIn, COALESCE(SUM(tokens_out),0) tokensOut,
            SUM(tokens_cached) tokensCached,
            COALESCE(SUM(CASE WHEN tokens_in IS NOT NULL OR tokens_out IS NOT NULL THEN 1 ELSE 0 END),0) tokenCalls,
            COALESCE(SUM(cost_usd),0) costUsd,
            COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END),0) pricedCalls,
            COALESCE(AVG(latency_ms),0) avgLatencyMs
     FROM requests WHERE started_at >= ? AND ${sql}
     GROUP BY hostname, method, normalized_endpoint
     ORDER BY calls DESC`).all(since, ...params) as UsageRow[]
}

export interface UsageNode {
  key: string
  label: string
  kind: 'vendor' | 'service' | 'host' | 'endpoint'
  llm: boolean
  calls: number
  errors: number
  bytesIn: number
  bytesOut: number
  bytesInKnown: number
  bytesOutKnown: number
  tokensIn: number
  tokensOut: number
  /** Sum of cache-read tokens over the subtree. null iff nothing under this node
   *  ever reported cache info — see `UsageRow.tokensCached` (spec §1.3). */
  tokensCached: number | null
  tokenCalls: number
  costUsd: number
  pricedCalls: number
  children: UsageNode[]
}

/** Numeric fields rolled up from leaf rows to every ancestor. `tokensCached` is
 *  rolled up separately (see below) since a plain `+=` can't tell "0" from
 *  "unreported" the way this list's fields can. */
const ROLLUP = [
  'calls', 'errors', 'bytesIn', 'bytesOut', 'bytesInKnown', 'bytesOutKnown',
  'tokensIn', 'tokensOut', 'tokenCalls', 'costUsd', 'pricedCalls',
] as const

function node(key: string, label: string, kind: UsageNode['kind']): UsageNode {
  return {
    key, label, kind, llm: false,
    calls: 0, errors: 0, bytesIn: 0, bytesOut: 0, bytesInKnown: 0, bytesOutKnown: 0,
    tokensIn: 0, tokensOut: 0, tokensCached: null, tokenCalls: 0, costUsd: 0, pricedCalls: 0, children: [],
  }
}

function child(parent: UsageNode, key: string, label: string, kind: UsageNode['kind']): UsageNode {
  let n = parent.children.find((c) => c.key === key)
  if (!n) { n = node(key, label, kind); parent.children.push(n) }
  return n
}

/** Drill-down tree: vendor > service > host > endpoint.
 *  Vendor and service are resolved from `hostname` at read time (never stored),
 *  so adding a host rule re-buckets all retained history with no backfill. */
export function usageTree(
  db: StorageDriver, opts: { now?: number; windowDays?: number; scope?: Scope | null } = {},
): UsageNode[] {
  const root = node('', '', 'vendor')
  for (const r of usageRows(db, opts)) {
    const h = resolveHost(r.hostname)
    const v = child(root, `v:${h.vendor}`, h.vendor, 'vendor')
    const s = child(v, `${v.key}/s:${h.service}`, h.service, 'service')
    const host = child(s, `${s.key}/h:${r.hostname}`, r.hostname, 'host')
    const ep = child(host, `${host.key}/e:${r.method} ${r.endpoint}`, `${r.method} ${r.endpoint}`, 'endpoint')
    for (const n of [v, s, host, ep]) {
      for (const f of ROLLUP) n[f] += r[f]
      if (r.tokensCached != null) n.tokensCached = (n.tokensCached ?? 0) + r.tokensCached
      if (h.entityClass === 'llm') n.llm = true
    }
  }
  root.children.forEach(collapse)
  return root.children.sort((a, b) => b.calls - a.calls)
}

/** Drop intermediate levels that carry no information. A node whose only child is
 *  itself a grouping level (not an endpoint) adopts its grandchildren — so a
 *  one-service vendor like Resend renders straight to its endpoints instead of
 *  costing three keystrokes to reach the same rows. Totals are unaffected: a sole
 *  child's numbers already equal its parent's. */
function collapse(n: UsageNode): void {
  while (n.children.length === 1 && n.children[0].kind !== 'endpoint') {
    n.children = n.children[0].children
  }
  n.children.forEach(collapse)
  n.children.sort((a, b) => b.calls - a.calls)
}

export interface TraceFilter {
  /** true = LLM calls only · false = everything else · null = both, interleaved.
   *  The third mode is what makes a unified Logs stream possible. */
  llm?: boolean | null
  entity?: string
  /** 4xx/5xx plus network failures, which land as status NULL. */
  errorsOnly?: boolean
}

/** One predicate builder shared by `traces` and `liveTail`, so a followed stream
 *  can never show a row the paged view would have filtered out. */
function filterSql(f: TraceFilter): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  if (f.llm === true) parts.push(`r.entity_class = 'llm'`)
  else if (f.llm === false) parts.push(`r.entity_class != 'llm'`)
  if (f.entity) { parts.push(`r.entity = ?`); params.push(f.entity) }
  if (f.errorsOnly) parts.push(`(r.status >= 400 OR r.status IS NULL)`)
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params }
}

export function traces(
  db: StorageDriver, opts: TraceFilter & { limit?: number; beforeId?: number; scope?: Scope | null },
): TraceRow[] {
  const f = filterSql(opts)
  const s = scopeSql(opts.scope, 'r')
  const params = [...f.params, ...s.params]
  // `!= null`, not truthiness: id 0 is not a valid row id today, but a cursor
  // that silently means "no cursor" is a bug waiting for the day it is.
  const before = opts.beforeId != null ? ' AND r.id < ?' : ''
  if (opts.beforeId != null) params.push(opts.beforeId)
  return db.prepare(
    `${TRACE_SELECT} WHERE ${f.sql} AND ${s.sql}${before} ORDER BY r.id DESC LIMIT ?`)
    .all(...params, opts.limit ?? 50) as TraceRow[]
}

/** Every trace mapped to the root of its tree. Used by both trace queries — one
 *  recursive walk beats a per-trace CTE, and it is the only place the tree shape
 *  is interpreted in SQL. */
const ROOTS_CTE = `
  WITH RECURSIVE roots(id, root) AS (
    SELECT id, id FROM traces WHERE parent_id IS NULL
    UNION ALL
    SELECT t.id, r.root FROM traces t JOIN roots r ON t.parent_id = r.id
  )`

const LLM_MARK = '◆'
const API_MARK = '◇'

export interface TraceListRow {
  /** null for a synthetic row standing in for an untraced request. */
  id: number | null
  /** Set on synthetic rows so ⏎ still opens something. */
  requestId: number | null
  name: string
  kind: string
  startedAt: number
  endedAt: number | null
  status: number | null
  incomplete: boolean
  calls: number
  costUsd: number
  pricedCalls: number
  /** Sums over the trace's requests; null iff NO request reported that side —
   *  a rollup must render `—` exactly where its leaves do, never invent a 0. */
  tokensIn: number | null
  tokensOut: number | null
  tokenCalls: number
  /** Sum of cache-read tokens over the trace's requests. null iff none of them
   *  reported cache info — distinct from "0 cached", which TraceList's `↺`
   *  glyph must never imply for an unknown value. */
  tokensCached: number | null
  durationMs: number | null
  /** '◆◇◆◇' — the trace's shape, readable before opening it. */
  steps: string
}

export function traceList(db: StorageDriver, opts: {
  now?: number; limit?: number; beforeStartedAt?: number; scope?: Scope | null
} = {}): TraceListRow[] {
  const limit = opts.limit ?? 50
  const s = scopeSql(opts.scope, 'rt')
  const before = opts.beforeStartedAt != null ? ' AND rt.started_at < ?' : ''
  const beforeParams = opts.beforeStartedAt != null ? [opts.beforeStartedAt] : []

  const traces = db.prepare(`${ROOTS_CTE}
    SELECT rt.id, rt.name, rt.kind, rt.started_at AS startedAt, rt.ended_at AS endedAt,
           rt.status, rt.incomplete,
           COUNT(rq.id) calls,
           COALESCE(SUM(rq.cost_usd),0) costUsd,
           COALESCE(SUM(CASE WHEN rq.cost_usd IS NOT NULL THEN 1 ELSE 0 END),0) pricedCalls,
           SUM(rq.tokens_in) tokensIn,
           SUM(rq.tokens_out) tokensOut,
           COALESCE(SUM(CASE WHEN rq.tokens_in IS NOT NULL OR rq.tokens_out IS NOT NULL THEN 1 ELSE 0 END),0) tokenCalls,
           SUM(rq.tokens_cached) tokensCached
    FROM traces rt
    LEFT JOIN roots ro ON ro.root = rt.id
    LEFT JOIN requests rq ON rq.trace_id = ro.id
    WHERE rt.parent_id IS NULL AND ${s.sql}${before}
    GROUP BY rt.id
    ORDER BY rt.started_at DESC LIMIT ?`).all(...s.params, ...beforeParams, limit)

  const shapes = stepShapes(db, traces.map((t: any) => t.id))

  const rows: TraceListRow[] = traces.map((t: any) => ({
    id: t.id, requestId: null,
    name: t.name ?? '(unnamed)',
    kind: t.kind,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    status: t.status,
    incomplete: t.incomplete === 1,
    calls: t.calls, costUsd: t.costUsd, pricedCalls: t.pricedCalls,
    tokensIn: t.tokensIn, tokensOut: t.tokensOut, tokenCalls: t.tokenCalls,
    tokensCached: t.tokensCached,
    durationMs: t.endedAt != null ? t.endedAt - t.startedAt : null,
    steps: shapes.get(t.id) ?? '',
  }))

  // Untraced LLM calls still appear, as single-step rows labelled by model.
  // Bedrock traffic from a script has no inbound request to root against and
  // would otherwise vanish from a trace-only list (§4.2b: nothing hidden).
  const rs = scopeSql(opts.scope, 'r')
  const loose = db.prepare(`
    SELECT r.id AS requestId, r.model, r.entity, r.started_at AS startedAt, r.status,
           r.latency_ms AS latencyMs, r.cost_usd AS costUsd, r.tokens_in AS tokensIn, r.tokens_out AS tokensOut,
           r.tokens_cached AS tokensCached
    FROM requests r
    WHERE r.trace_id IS NULL AND r.entity_class = 'llm' AND ${rs.sql}
      ${opts.beforeStartedAt != null ? 'AND r.started_at < ?' : ''}
    ORDER BY r.started_at DESC LIMIT ?`)
    .all(...rs.params, ...beforeParams, limit)

  for (const r of loose as any[]) {
    rows.push({
      id: null, requestId: r.requestId,
      name: r.model ?? r.entity,
      kind: 'untraced',
      startedAt: r.startedAt,
      endedAt: r.latencyMs != null ? r.startedAt + r.latencyMs : null,
      status: r.status,
      incomplete: false,
      calls: 1,
      costUsd: r.costUsd ?? 0,
      pricedCalls: r.costUsd != null ? 1 : 0,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      tokenCalls: r.tokensIn != null || r.tokensOut != null ? 1 : 0,
      tokensCached: r.tokensCached,
      durationMs: r.latencyMs,
      steps: LLM_MARK,
    })
  }

  return rows.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

/** Step markers per root trace, built in JS: `group_concat` has no portable
 *  ordering guarantee, and the shape column is meaningless if the order is wrong. */
function stepShapes(db: StorageDriver, rootIds: number[]): Map<number, string> {
  const out = new Map<number, string>()
  if (rootIds.length === 0) return out
  const marks = db.prepare(`${ROOTS_CTE}
    SELECT ro.root, rq.entity_class AS cls
    FROM roots ro JOIN requests rq ON rq.trace_id = ro.id
    WHERE ro.root IN (${rootIds.map(() => '?').join(',')})
    ORDER BY rq.seq, rq.id`).all(...rootIds)
  for (const m of marks as any[]) {
    out.set(m.root, (out.get(m.root) ?? '') + (m.cls === 'llm' ? LLM_MARK : API_MARK))
  }
  return out
}

export interface TraceTreeNode {
  type: 'trace' | 'tool' | 'request'
  id: number
  depth: number
  label: string
  startedAt: number
  endedAt: number | null
  /** Forced null when the owning trace was force-closed by the sweep
   *  (`incomplete`): an observation window is not a duration (spec §4). */
  durationMs: number | null
  status: number | null
  costUsd: number | null
  pricedCalls: number
  tokensIn: number | null
  tokensOut: number | null
  /** null iff nothing in scope (this row, or its whole subtree for a
   *  trace/tool node) ever reported cache info — distinct from "0 cached". */
  tokensCached: number | null
  tokensCacheWrite: number | null
  /** Calls that reported either side of token usage. A request row is 0 or 1;
   *  a trace/tool row is the count over its subtree. */
  tokenCalls: number
  /** Request rows only — a trace/tool row aggregates many requests, so a
   *  single byte count would not mean anything. */
  reqBytes: number | null
  resBytes: number | null
  calls: number
  llm: boolean
  incomplete: boolean
  hostname: string | null
  model: string | null
  /** Request rows only; null on trace/tool rows. Kept separate from `label`
   *  so a fold header can group by verb without parsing it back out. */
  method: string | null
  requestId: number | null
  /** Calls this trace directly owned that the retention sweep deleted before
   *  it could render them. 0 on request rows; not summed over a subtree —
   *  each trace only knows what the sweep took from itself (spec §4). */
  expiredCalls: number
  /** Tool nodes only. */
  toolStatus: string | null
  /** How this node's children were assigned: exact · window · turn · none.
   *  Stored so the UI can distinguish inferred nesting from known nesting
   *  rather than presenting a guess as certainty (§8.4). */
  attribution: string | null
}

/** The subtree of one trace, flattened depth-first and ready to indent.
 *  Ordered by `seq`, which is shared across the whole tree (see `context/trace.ts`),
 *  so a nested trace sorts against its siblings by when its first call happened. */
export function traceTree(
  db: StorageDriver, traceId: number,
): { root: TraceTreeNode; nodes: TraceTreeNode[] } | null {
  const traces = db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM traces WHERE id = ?
      UNION ALL
      SELECT t.id FROM traces t JOIN subtree s ON t.parent_id = s.id
    )
    SELECT t.id, t.parent_id AS parentId, t.name, t.kind, t.started_at AS startedAt,
           t.ended_at AS endedAt, t.status, t.incomplete,
           t.tool_status AS toolStatus, t.attribution, t.expired_calls AS expiredCalls
    FROM traces t WHERE t.id IN (SELECT id FROM subtree)`).all(traceId) as any[]
  if (traces.length === 0) return null

  const ids = traces.map((t) => t.id)
  const requests = db.prepare(`
    SELECT r.id, r.trace_id AS traceId, r.seq, r.method, r.normalized_endpoint AS endpoint,
           r.hostname, r.entity_class AS cls, r.model, r.status, r.started_at AS startedAt,
           r.latency_ms AS latencyMs, r.cost_usd AS costUsd, r.tokens_in AS tokensIn, r.tokens_out AS tokensOut,
           r.tokens_cached AS tokensCached, r.tokens_cache_write AS tokensCacheWrite,
           r.req_bytes AS reqBytes, r.res_bytes AS resBytes
    FROM requests r WHERE r.trace_id IN (${ids.map(() => '?').join(',')})
    ORDER BY r.seq, r.id`).all(...ids) as any[]

  // §8.4 — a tool call is bracketed by two events burn0 observes: the response
  // that declared it, and the request carrying its result. Calls inside that
  // window are the tool's. This is the one inferred step in the whole tree, and
  // it runs at read time because the window is metadata (30 days) while the
  // payloads it was extracted from are not (7 days).
  const reqsByTrace = new Map<number, any[]>()
  for (const r of requests) {
    const owner = attributeToTool(r, traces)
    reqsByTrace.set(owner, [...(reqsByTrace.get(owner) ?? []), r])
  }

  // Roll each trace node up over its own subtree, not just its direct requests.
  // tokensCached/tokensCacheWrite track a "known" flag alongside their sum —
  // the same null-vs-0 distinction §1.3 requires at the leaf (a rollup that
  // can't tell "nothing reported" from "reported zero" must never imply either).
  interface Stats {
    calls: number; costUsd: number; priced: number; tokenCalls: number
    tin: number; tinKnown: boolean; tout: number; toutKnown: boolean
    tcached: number; tcachedKnown: boolean; tcw: number; tcwKnown: boolean
  }
  const subtreeStats = (id: number): Stats => {
    const own = reqsByTrace.get(id) ?? []
    const acc: Stats = {
      calls: own.length,
      costUsd: own.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      priced: own.filter((r) => r.costUsd != null).length,
      // Every token sum carries a "known" flag: a rollup over rows that never
      // reported a side must say null, not manufacture the 0 the leaf refuses
      // to show (spec §1.3 — the leaf renders `—→846`, so must the root).
      tin: own.reduce((s, r) => s + (r.tokensIn ?? 0), 0),
      tinKnown: own.some((r) => r.tokensIn != null),
      tout: own.reduce((s, r) => s + (r.tokensOut ?? 0), 0),
      toutKnown: own.some((r) => r.tokensOut != null),
      tokenCalls: own.filter((r) => r.tokensIn != null || r.tokensOut != null).length,
      tcached: own.reduce((s, r) => s + (r.tokensCached ?? 0), 0),
      tcachedKnown: own.some((r) => r.tokensCached != null),
      tcw: own.reduce((s, r) => s + (r.tokensCacheWrite ?? 0), 0),
      tcwKnown: own.some((r) => r.tokensCacheWrite != null),
    }
    for (const child of traces.filter((t) => t.parentId === id)) {
      const c = subtreeStats(child.id)
      acc.calls += c.calls; acc.costUsd += c.costUsd; acc.priced += c.priced
      acc.tin += c.tin; acc.tinKnown = acc.tinKnown || c.tinKnown
      acc.tout += c.tout; acc.toutKnown = acc.toutKnown || c.toutKnown
      acc.tokenCalls += c.tokenCalls
      acc.tcached += c.tcached; acc.tcachedKnown = acc.tcachedKnown || c.tcachedKnown
      acc.tcw += c.tcw; acc.tcwKnown = acc.tcwKnown || c.tcwKnown
    }
    return acc
  }

  const out: TraceTreeNode[] = []
  const walk = (t: any, depth: number) => {
    const stats = subtreeStats(t.id)
    out.push({
      type: t.kind === 'tool' ? 'tool' : 'trace', id: t.id, depth,
      label: t.name ?? '(unnamed)',
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      // An observation window forced closed by the sweep is not a duration.
      durationMs: t.incomplete === 1 ? null : (t.endedAt != null ? t.endedAt - t.startedAt : null),
      status: t.status,
      costUsd: stats.costUsd, pricedCalls: stats.priced,
      tokensIn: stats.tinKnown ? stats.tin : null,
      tokensOut: stats.toutKnown ? stats.tout : null,
      tokensCached: stats.tcachedKnown ? stats.tcached : null,
      tokensCacheWrite: stats.tcwKnown ? stats.tcw : null,
      tokenCalls: stats.tokenCalls,
      reqBytes: null, resBytes: null,
      calls: stats.calls,
      llm: false, incomplete: t.incomplete === 1,
      hostname: null, model: null, method: null, requestId: null,
      expiredCalls: t.expiredCalls,
      toolStatus: t.toolStatus ?? null, attribution: t.attribution ?? null,
    })
    // Children of this trace — sub-traces, tool nodes and requests — interleaved
    // by start time. `startedAt` rather than `seq`, because a tool node has no
    // seq of its own and one that made no calls has no requests to borrow from.
    const kids: Array<{ at: number; node: any; isTrace: boolean }> = []
    for (const r of reqsByTrace.get(t.id) ?? []) kids.push({ at: r.startedAt, node: r, isTrace: false })
    for (const c of traces.filter((x) => x.parentId === t.id)) {
      kids.push({ at: c.startedAt, node: c, isTrace: true })
    }
    kids.sort((a, b) => a.at - b.at)
    for (const k of kids) {
      if (k.isTrace) { walk(k.node, depth + 1); continue }
      const r = k.node
      out.push({
        type: 'request', id: r.id, depth: depth + 1,
        label: `${r.method} ${r.endpoint}`,
        startedAt: r.startedAt,
        // No stored end timestamp on a request row — derived the same way
        // traceList's synthetic untraced rows already do.
        endedAt: r.latencyMs != null ? r.startedAt + r.latencyMs : null,
        durationMs: r.latencyMs,
        status: r.status,
        costUsd: r.costUsd, pricedCalls: r.costUsd != null ? 1 : 0,
        tokensIn: r.tokensIn, tokensOut: r.tokensOut,
        tokensCached: r.tokensCached, tokensCacheWrite: r.tokensCacheWrite,
        tokenCalls: r.tokensIn != null || r.tokensOut != null ? 1 : 0,
        reqBytes: r.reqBytes, resBytes: r.resBytes,
        calls: 1,
        llm: r.cls === 'llm', incomplete: false,
        hostname: r.hostname, model: r.model, method: r.method, requestId: r.id,
        expiredCalls: 0,
        toolStatus: null, attribution: null,
      })
    }
  }

  const root = traces.find((t) => t.id === traceId)!
  walk(root, 0)
  return { root: out[0], nodes: out }
}

/** Which node owns a request: a tool whose window contains it, else the trace it
 *  was captured in.
 *
 *  Exactly one candidate wins. Several tools declared in one turn run
 *  concurrently, so their windows overlap and nothing can honestly say which
 *  caused a given call — those stay at the turn level as siblings. That is the
 *  difference between an inference and a guess. */
function attributeToTool(r: any, traces: any[]): number {
  const tools = traces.filter((t) =>
    t.kind === 'tool' && t.parentId === r.traceId && t.attribution === 'window')
  // Half-open: the window closes *at* the request carrying the result, so that
  // request is the boundary and not a member. Including it would make every
  // resolved tool look like it called the LLM back itself.
  const inWindow = tools.filter((t) =>
    r.startedAt >= t.startedAt && (t.endedAt == null || r.startedAt < t.endedAt))
  return inWindow.length === 1 ? inWindow[0].id : r.traceId
}

/** A tool's raw call/result, written when the tool trace closes and never read
 *  until a detail pane wants it (spec §5). null iff the tool's trace row (and
 *  its `tool_io` row along with it) has since been pruned. */
export function toolIo(db: StorageDriver, traceId: number):
    { args: string | null; result: string | null; truncated: boolean } | null {
  const row = db.prepare(`SELECT args, result, truncated FROM tool_io WHERE trace_id = ?`).get(traceId)
  return row ? { args: row.args ?? null, result: row.result ?? null, truncated: !!row.truncated } : null
}

export function requestDetail(db: StorageDriver, id: number) {
  const row = db.prepare(`
    SELECT r.id, r.started_at AS startedAt, r.method, r.entity, r.provider,
           r.normalized_endpoint AS normalizedEndpoint, r.status, r.latency_ms AS latencyMs,
           r.model, r.tokens_in AS tokensIn, r.tokens_out AS tokensOut, r.tokens_cached AS tokensCached,
           r.tokens_cache_write AS tokensCacheWrite,
           r.cost_usd AS costUsd, r.first_byte_ms AS firstByteMs,
           r.req_bytes AS reqBytes, r.res_bytes AS resBytes,
           r.url, r.tags, p.name AS project
    FROM requests r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).get(id)
  if (!row) return null
  const payload = db.prepare(
    `SELECT req_headers AS reqHeaders, req_body AS reqBody, res_headers AS resHeaders,
            res_body AS resBody, stack_snippet AS stackSnippet,
            req_truncated AS reqTruncated, res_truncated AS resTruncated
     FROM payloads WHERE request_id = ?`).get(id) ?? null
  return { ...row, payload }
}

export function liveTail(
  db: StorageDriver, afterId: number, opts: TraceFilter & { limit?: number; scope?: Scope | null } = {},
): TraceRow[] {
  const f = filterSql(opts)
  const s = scopeSql(opts.scope, 'r')
  return db.prepare(`${TRACE_SELECT} WHERE r.id > ? AND ${f.sql} AND ${s.sql} ORDER BY r.id ASC LIMIT ?`)
    .all(afterId, ...f.params, ...s.params, opts.limit ?? 200) as TraceRow[]
}

export function todaySummary(db: StorageDriver, now = Date.now(), scope?: Scope | null) {
  const since = startOfToday(now)
  const { sql, params } = scopeSql(scope)
  const head = db.prepare(
    `SELECT COALESCE(SUM(cost_usd),0) s, COUNT(*) c FROM requests WHERE started_at >= ? AND ${sql}`)
    .get(since, ...params)
  const topModels = db.prepare(
    `SELECT model, COALESCE(SUM(cost_usd),0) costUsd, COUNT(*) calls
     FROM requests WHERE started_at >= ? AND model IS NOT NULL AND ${sql}
     GROUP BY model ORDER BY costUsd DESC LIMIT 5`).all(since, ...params)
  const topEntities = db.prepare(
    `SELECT entity, COUNT(*) calls, COALESCE(SUM(cost_usd),0) costUsd
     FROM requests WHERE started_at >= ? AND ${sql} GROUP BY entity ORDER BY calls DESC LIMIT 5`)
    .all(since, ...params)
  return { spendToday: head.s, callsToday: head.c, topModels, topEntities }
}

export function dbStats(db: StorageDriver, scope?: Scope | null) {
  const { sql, params } = scopeSql(scope)
  return {
    requestCount: db.prepare(`SELECT COUNT(*) c FROM requests WHERE ${sql}`).get(...params).c as number,
    payloadCount: db.prepare(
      `SELECT COUNT(*) c FROM payloads WHERE request_id IN (SELECT id FROM requests WHERE ${sql})`)
      .get(...params).c as number,
    maxRequestId: db.prepare(`SELECT COALESCE(MAX(id),0) m FROM requests WHERE ${sql}`).get(...params).m as number,
  }
}

/** Columns the export dumps. Metadata only — payloads are never exported. */
export const EXPORT_COLS = [
  'id', 'project_id', 'service', 'entity', 'entity_class', 'provider', 'method', 'normalized_endpoint',
  'hostname', 'status', 'started_at', 'first_byte_ms', 'latency_ms', 'req_bytes', 'res_bytes',
  'model', 'tokens_in', 'tokens_out', 'tokens_cached', 'cost_usd', 'estimated',
] as const

/** Scoped, so `burn0 export` no longer dumps every project on the machine (P2). */
export function exportRows(db: StorageDriver, scope?: Scope | null): Record<string, unknown>[] {
  const { sql, params } = scopeSql(scope)
  return db.prepare(`SELECT ${EXPORT_COLS.join(', ')} FROM requests WHERE ${sql} ORDER BY id`)
    .all(...params) as Record<string, unknown>[]
}

export interface ProjectSummary {
  id: number
  key: string
  name: string
  rootPath: string | null
  gitRoot: string | null
  services: string[]
  calls: number
  lastSeen: number
}

export function projects(db: StorageDriver): ProjectSummary[] {
  const rows = db.prepare(`
    SELECT p.id, p.key, p.name, p.root_path AS rootPath, p.git_root AS gitRoot,
           COUNT(r.id) calls, COALESCE(MAX(r.started_at),0) lastSeen
    FROM projects p LEFT JOIN requests r ON r.project_id = p.id
    GROUP BY p.id ORDER BY lastSeen DESC`).all()
  return rows.map((p: any) => ({
    ...p,
    services: servicesFor(db, { projectIds: [p.id], services: null }),
  }))
}

/** Distinct non-null services inside a scope. Empty in a single-package repo,
 *  which is how the UI knows not to render a Service column or bind `s`. */
export function servicesFor(db: StorageDriver, scope?: Scope | null): string[] {
  const { sql, params } = scopeSql(scope)
  return db.prepare(
    `SELECT DISTINCT service FROM requests WHERE service IS NOT NULL AND ${sql} ORDER BY service`)
    .all(...params).map((r: any) => r.service as string)
}
