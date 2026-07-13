# burn0 v0.3 — Local-First Core: Storage, Counts & TUI

**Version:** 0.3 (supersedes Draft 0.1 "burn0 — Product & Technical Specification")
**Date:** July 13, 2026
**Author:** Rafi (Alif Labs)
**Status:** Implementation spec — code in this document is the reference implementation

---

## 0. Decisions Ratified

This spec resolves the direction question left open between Draft 0.1 and the
v0.2.x codebase. These are now decided:

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Fully local-first.** CLI + TUI now, local web dashboard later. The cloud path (`BURN0_API_KEY`, `shipEvents`, Railway backend) stays in the codebase but is **parked**: undocumented, never advertised, only active if a key is explicitly set. | Bottom-up dev-tool adoption runs on trust + zero friction. Cloud/team tier returns after traction. |
| D2 | **Pricing is deferred.** No pricing fetch, no bundled table work in this milestone. Cost columns render `—` until pricing lands behind the `CostEstimator` seam (§8). The startup fetch to the backend `/v1/pricing` is **removed** (it contradicted "zero network calls in local mode"). | Counts, latency, tokens, and errors are already valuable without dollars. Pricing is a separable layer. |
| D3 | **Storage: append-only JSONL daily segments** under `~/.burn0/`, not SQLite. Zero native dependencies, crash-safe, multi-process-safe appends, retention = deleting old files. | See §3.1 for the full trade-off analysis. |
| D4 | **TUI (Ink) becomes the default `burn0` command.** `burn0 report` remains for non-TTY / scripts. | The TUI is the product's face; the flagship "screenshot surface" until the web dashboard ships. |
| D5 | **Event schema v2** adds `id`, `host`, `method`, `bytes_in/out`, `tokens_cached`, `project`. One-shot migration imports the legacy per-project `.burn0/costs.jsonl`. | The TUI screens need method/host; global storage needs project stamped on each row. |
| D6 | **Payload capture (bodies/headers) is Phase 3, opt-in** (`BURN0_CAPTURE_BODIES=1`), 7-day retention, 1 MB cap. Metadata-only remains the default. | Keeps the "never reads content" default true, while unlocking the request-detail screen for those who opt in. |

Out of scope for this milestone: pricing (§8 seam only), web dashboard, cloud
sync, non-HTTP protocols.

---

## 1. Architecture Overview

```
src/
├── index.ts              # SDK entry — patches, dispatch (existing; small wiring change §3.8)
├── interceptor/          # UNCHANGED — fetch + http patching, stream, guard
├── track.ts              # UNCHANGED — AsyncLocalStorage feature attribution
├── store/                # NEW — the storage engine (replaces transport/local.ts)
│   ├── paths.ts          # ~/.burn0 layout, slug rules
│   ├── project.ts        # project identity resolution + registry
│   ├── segments.ts       # SegmentStore: append + read daily JSONL segments
│   ├── payloads.ts       # PayloadStore (Phase 3, opt-in)
│   ├── retention.ts      # pruning: 30d events, 7d payloads
│   └── migrate.ts        # one-shot import of legacy .burn0/costs.jsonl
├── query/                # NEW — counts & aggregation (pure functions, no I/O)
│   ├── normalize.ts      # endpoint normalization (:id, :uuid, :hash)
│   └── aggregate.ts      # summaries, rollups, percentiles, time buckets
├── pricing/              # SEAM ONLY this milestone
│   └── estimator.ts      # CostEstimator interface + NullEstimator
├── tui/                  # NEW — Ink terminal dashboard
│   ├── main.tsx          # entry: raw-mode check, project pick, render <App/>
│   ├── App.tsx           # shell: tab bar, screen router, global keys
│   ├── theme.ts          # colors, glyphs, number formatting
│   ├── hooks/
│   │   ├── useEvents.ts  # load window + live re-read on file change
│   │   └── useTail.ts    # incremental tail of today's segment (Live screen)
│   ├── components/
│   │   ├── TabBar.tsx
│   │   ├── MetricStrip.tsx
│   │   ├── Table.tsx     # generic selectable table
│   │   └── Sparkline.tsx
│   └── screens/
│       ├── Overview.tsx
│       ├── EntityDetail.tsx
│       ├── LlmTraces.tsx
│       ├── ApiTraces.tsx
│       ├── Live.tsx
│       └── RequestDetail.tsx
├── cli/                  # existing commands + new `today`, `watch`; default → TUI
└── transport/            # cloud shipper stays but is parked (D1)
```

Data flow:

```
app request ──▶ interceptor ──▶ enrichEvent (feature tags) ──▶ dispatcher
                                                                  │
                                              ┌───────────────────┤
                                              ▼                   ▼
                                        ticker (stderr)    SegmentStore.append()
                                                                  │
                                                     ~/.burn0/projects/<slug>/events/YYYY-MM-DD.jsonl
                                                                  │
                              burn0 (TUI) / burn0 report / burn0 today ── read-only
```

Capture is decoupled from viewing (principle #3 from Draft 0.1, unchanged):
the SDK writes whenever the app runs; the TUI/CLI are pure readers.

---

## 2. Data Model — Event Schema v2

`src/types.ts` (replaces v1 event):

```ts
export const SCHEMA_VERSION = 2

export interface Burn0Event {
  schema_version: 2
  /** Unique id, links payload files. "evt_" + ms base36 + 4 random base36 chars */
  id: string
  /** Project slug this event belongs to (stamped at write time) */
  project: string
  /** Detected service key ("openai", "supabase", "unknown:api.foo.com") */
  service: string
  /** Raw hostname, always kept even when service is detected */
  host: string
  /** HTTP method, uppercase */
  method: string
  /** Normalized path template ("/v1/users/:id"), query string stripped */
  endpoint: string
  /** LLM fields — present only for detected LLM services */
  model?: string
  tokens_in?: number
  tokens_out?: number
  tokens_cached?: number
  status_code: number
  /** ISO 8601 with ms, always UTC */
  timestamp: string
  duration_ms: number
  /** Request/response body sizes when cheaply known (Content-Length) */
  bytes_out?: number
  bytes_in?: number
  /** True when token counts were estimated rather than reported by the API */
  estimated: boolean
  /** Feature attribution from track() */
  feature?: string
  metadata?: Record<string, string | number | boolean>
}

export function newEventId(now = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
  return `evt_${now.toString(36)}${rand}`
}
```

Size check: a typical serialized v2 event is 280–380 bytes. Heavy usage
(2,000 calls/day) over the 30-day window ≈ **18–23 MB** total. Loading a full
window is a sub-second operation; no index needed (§3.1).

---

## 3. Storage Engine

### 3.1 Why JSONL segments, not SQLite

| Concern | JSONL daily segments | SQLite (better-sqlite3) |
|---|---|---|
| Install friction | zero — no native dep, no prebuilds | ~2 MB native addon; postinstall pain on odd platforms — poison for a "zero-setup" tool |
| Concurrent writers (several services on one machine) | `O_APPEND` + one `write()` per line: appends never corrupt each other | WAL helps readers, but writers still serialize; busy-loop contention across processes |
| Crash safety | a torn final line is skipped by the reader; nothing else is at risk | good, but a corrupted db is catastrophic |
| Retention | `unlink()` old day-files — O(1), atomic, no VACUUM | `DELETE` + periodic `VACUUM` |
| Live tail (TUI Network screen) | `fs.watch` + read from byte offset — natural fit | requires polling queries |
| Query power | none — but our window is ≤ ~25 MB, in-memory aggregation is < 100 ms | real SQL, unnecessary at this scale |
| Human-debuggable | `cat`-able | needs tooling |

At burn0's data scale (tens of MB max), SQL buys nothing and the native
dependency costs a lot. If a future feature genuinely needs indexes (multi-year
history, the web dashboard at team scale), `node:sqlite` (Node ≥ 22.5) is the
migration target — not `better-sqlite3`. Revisit then, not now.

### 3.2 On-disk layout

```
~/.burn0/
├── meta.json                          # { "schema": 2, "created_at": "..." }
├── projects.json                      # registry, see §3.4
└── projects/
    └── my-api/                        # project slug
        ├── events/
        │   ├── 2026-07-11.jsonl       # one metadata event per line
        │   ├── 2026-07-12.jsonl
        │   └── 2026-07-13.jsonl       # "today" — the live tail target
        ├── payloads/                  # Phase 3, opt-in only
        │   └── 2026-07-13/
        │       └── evt_ly2k9frq1x.json
        └── last-prune                 # mtime stamp, throttles pruning
```

Segment file names are **UTC dates** (matching `timestamp`), so day boundaries
are unambiguous across timezones and machines.

`src/store/paths.ts`:

```ts
import os from "node:os"
import path from "node:path"

export function burn0Home(): string {
  // BURN0_HOME override is for tests and unusual setups (e.g. read-only $HOME)
  return process.env.BURN0_HOME ?? path.join(os.homedir(), ".burn0")
}

export function projectDir(slug: string): string {
  return path.join(burn0Home(), "projects", slug)
}

export function eventsDir(slug: string): string {
  return path.join(projectDir(slug), "events")
}

export function segmentPath(slug: string, dayUtc: string): string {
  return path.join(eventsDir(slug), `${dayUtc}.jsonl`)
}

/** "2026-07-13" for a given epoch-ms, in UTC */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
```

### 3.3 Project identity

Same resolution order as Draft 0.1, now with concrete code and a slug rule:

1. `burn0.config.json` → `projectName` (explicit override)
2. Nearest `package.json` `name`, walking up from `process.cwd()`
3. Fallback: basename of `process.cwd()`

Dedup is by slug (derived from package name), so the same project cloned into
two folders stays one project.

`src/store/project.ts`:

```ts
import fs from "node:fs"
import path from "node:path"
import { burn0Home } from "./paths"

export interface ProjectRef {
  slug: string
  name: string
  rootPath: string
}

/** "@acme/My API!" → "acme-my-api" */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "default"
  )
}

export function resolveProject(cwd = process.cwd()): ProjectRef {
  let dir = cwd
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const cfgPath = path.join(dir, "burn0.config.json")
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"))
        if (typeof cfg.projectName === "string" && cfg.projectName) {
          return { slug: slugify(cfg.projectName), name: cfg.projectName, rootPath: dir }
        }
      }
      const pkgPath = path.join(dir, "package.json")
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
        if (typeof pkg.name === "string" && pkg.name) {
          return { slug: slugify(pkg.name), name: pkg.name, rootPath: dir }
        }
      }
    } catch {} // malformed json — keep walking
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const base = path.basename(cwd)
  return { slug: slugify(base), name: base, rootPath: cwd }
}

interface RegistryEntry {
  name: string
  rootPath: string
  first_seen: string
  last_seen: string
}

/** Best-effort registry so the TUI can list all projects on the machine. */
export function touchRegistry(ref: ProjectRef): void {
  try {
    const file = path.join(burn0Home(), "projects.json")
    let reg: Record<string, RegistryEntry> = {}
    try {
      reg = JSON.parse(fs.readFileSync(file, "utf-8"))
    } catch {}
    const now = new Date().toISOString()
    reg[ref.slug] = {
      name: ref.name,
      rootPath: ref.rootPath,
      first_seen: reg[ref.slug]?.first_seen ?? now,
      last_seen: now,
    }
    fs.mkdirSync(burn0Home(), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(reg, null, 2))
  } catch {} // registry is a convenience, never worth failing over
}

export function listProjects(): Array<{ slug: string } & RegistryEntry> {
  try {
    const file = path.join(burn0Home(), "projects.json")
    const reg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, RegistryEntry>
    return Object.entries(reg)
      .map(([slug, e]) => ({ slug, ...e }))
      .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
  } catch {
    return []
  }
}
```

Monorepos: the nearest-`package.json` walk gives per-service identity
(`apps/api` has its own `package.json` → its own slug). A root
`burn0.config.json` with `projectName` collapses a whole monorepo into one
project when that's wanted instead.

### 3.4 The writer — `SegmentStore`

Design constraints:

- **One `write()` syscall per event line.** With the fd opened `O_APPEND`, the
  kernel makes each append atomic on local filesystems for our line sizes
  (< 1 KB, far under any practical interleave threshold). Multiple processes
  writing the same project's segment never corrupt each other's lines.
- **Cached fd with rollover.** The fd for today's segment is kept open;
  when the UTC day changes, close and reopen.
- **Every path is wrapped.** A storage failure (disk full, read-only home,
  permissions) silently disables writing — it must never throw into the app
  (principle #4). An internal drop counter is exposed for the TUI status line.

`src/store/segments.ts`:

```ts
import fs from "node:fs"
import path from "node:path"
import type { Burn0Event } from "../types"
import { eventsDir, segmentPath, utcDay } from "./paths"

export class SegmentStore {
  private fd: number | null = null
  private fdDay: string | null = null
  private disabled = false
  public dropped = 0

  constructor(private slug: string) {}

  append(event: Burn0Event): void {
    if (this.disabled) {
      this.dropped++
      return
    }
    try {
      const day = utcDay(Date.parse(event.timestamp) || Date.now())
      if (this.fd === null || this.fdDay !== day) this.rollover(day)
      // Single write() call — atomicity of the append depends on this.
      fs.writeSync(this.fd!, JSON.stringify(event) + "\n")
    } catch {
      this.dropped++
      // One retry with a fresh fd (handles deleted-under-us segment, stale fd)
      try {
        this.rollover(utcDay(Date.now()))
        fs.writeSync(this.fd!, JSON.stringify(event) + "\n")
        this.dropped--
      } catch {
        this.disabled = true // give up for this process; never block the app
      }
    }
  }

  private rollover(day: string): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {}
      this.fd = null
    }
    fs.mkdirSync(eventsDir(this.slug), { recursive: true })
    this.fd = fs.openSync(segmentPath(this.slug, day), "a") // O_APPEND
    this.fdDay = day
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {}
      this.fd = null
    }
  }
}
```

### 3.5 The reader

Readers tolerate torn/garbage lines (crash mid-write, disk hiccup): any line
that fails `JSON.parse` or lacks `id`/`timestamp` is skipped, counted, and
never fatal.

`src/store/segments.ts` (continued):

```ts
export interface ReadResult {
  events: Burn0Event[]
  skippedLines: number
}

export function listSegmentDays(slug: string): string[] {
  try {
    return fs
      .readdirSync(eventsDir(slug))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

/** Read all events with timestamp in [sinceMs, untilMs). Segment-granular file skip, per-event filter within. */
export function readRange(slug: string, sinceMs: number, untilMs: number): ReadResult {
  const events: Burn0Event[] = []
  let skippedLines = 0
  const firstDay = utcDay(sinceMs)
  const lastDay = utcDay(untilMs)

  for (const day of listSegmentDays(slug)) {
    if (day < firstDay || day > lastDay) continue
    let content: string
    try {
      content = fs.readFileSync(segmentPath(slug, day), "utf-8")
    } catch {
      continue
    }
    for (const line of content.split("\n")) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as Burn0Event
        if (!e.id || !e.timestamp) {
          skippedLines++
          continue
        }
        const t = Date.parse(e.timestamp)
        if (t >= sinceMs && t < untilMs) events.push(e)
      } catch {
        skippedLines++
      }
    }
  }
  // Segments are day-ordered but events within a day are append-ordered
  // across processes — sort once here so every consumer can rely on order.
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return { events, skippedLines }
}
```

Performance envelope: 60k events ≈ 20 MB → `readFileSync` + parse ≈ 150–400 ms
on a laptop. That is the *cold open* of the TUI; subsequent refreshes only
re-read today's segment (§6.4).

### 3.6 Retention

- **Events: 30 days** (fixed). Pruning = deleting segment files older than the
  cutoff. No rewrite, no VACUUM, atomic per file.
- **Payloads: 7 days** (Phase 3). Pruning = removing day-directories.
- Runs opportunistically at SDK init and CLI/TUI start, throttled to once per
  6 hours per project via the `last-prune` stamp file. No daemon.

`src/store/retention.ts`:

```ts
import fs from "node:fs"
import path from "node:path"
import { projectDir, segmentPath, utcDay, eventsDir } from "./paths"
import { listSegmentDays } from "./segments"

const EVENT_RETENTION_DAYS = 30
const PAYLOAD_RETENTION_DAYS = 7
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

export function pruneIfDue(slug: string, now = Date.now()): void {
  try {
    const stamp = path.join(projectDir(slug), "last-prune")
    try {
      if (now - fs.statSync(stamp).mtimeMs < PRUNE_INTERVAL_MS) return
    } catch {} // no stamp yet — prune

    const eventCutoff = utcDay(now - EVENT_RETENTION_DAYS * 86_400_000)
    for (const day of listSegmentDays(slug)) {
      if (day < eventCutoff) {
        try {
          fs.unlinkSync(segmentPath(slug, day))
        } catch {}
      }
    }

    const payloadCutoff = utcDay(now - PAYLOAD_RETENTION_DAYS * 86_400_000)
    const payloadsRoot = path.join(projectDir(slug), "payloads")
    try {
      for (const day of fs.readdirSync(payloadsRoot)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < payloadCutoff) {
          fs.rmSync(path.join(payloadsRoot, day), { recursive: true, force: true })
        }
      }
    } catch {}

    fs.mkdirSync(projectDir(slug), { recursive: true })
    fs.writeFileSync(stamp, String(now))
  } catch {} // pruning is best-effort, never fatal
}
```

### 3.7 Concurrency & failure matrix

| Situation | Behavior |
|---|---|
| Several processes of the same project writing simultaneously | Safe. Each event is one `O_APPEND` `write()`; lines interleave whole. Reader sorts by timestamp. |
| App writing while TUI reads | Safe. Reader may miss the newest bytes of an in-progress write → torn last line is skipped this pass, picked up next refresh. |
| Two processes prune concurrently | Safe. `unlink` of an already-gone file is caught; stamp write is last-writer-wins. |
| Disk full | `append` catches `ENOSPC`, retries once, then disables writes for the process (`dropped` counts). App unaffected. |
| `$HOME` unwritable (containers, serverless) | First `rollover()` throws → store disables itself. Ticker still works (in-memory). `BURN0_HOME` can point somewhere writable. |
| Reader finds garbage lines | Skipped and counted (`skippedLines`), surfaced in the TUI footer as a diagnostic, never fatal. |
| System clock jumps backward | Events land in an "old" segment; reader sorts by timestamp so display stays coherent. Retention uses day names, so worst case a file lives slightly long. |
| Legacy v1 events (from migration) | Migration rewrites them as v2 (§9); reader only ever sees v2. |

### 3.8 SDK wiring change (`src/index.ts`)

`LocalLedger` (project-local `costs.jsonl`) is replaced by `SegmentStore` +
retention + registry. The ticker and dispatcher are untouched.

```ts
import { resolveProject, touchRegistry } from "./store/project"
import { SegmentStore } from "./store/segments"
import { pruneIfDue } from "./store/retention"
import { migrateLegacyLedger } from "./store/migrate"

const project = resolveProject()
const store = new SegmentStore(project.slug)

try {
  migrateLegacyLedger(process.cwd(), project.slug) // one-shot, no-op after first run
  touchRegistry(project)
  pruneIfDue(project.slug)
} catch {}

// dispatcher wiring (writeLedger renamed conceptually to writeStore):
const dispatch = createDispatcher(mode, {
  logEvent: (e) => ticker.tick(e),
  writeLedger: shouldWriteLedger ? (e) => store.append(e) : undefined,
  addToBatch: (e) => {
    /* parked cloud path, unchanged */
  },
})

process.on("exit", () => {
  store.close()
  // ...existing exit summary
})
```

Ticker seeding ("today so far") switches from `ledger.read()` to
`readRange(project.slug, startOfUtcToday, now)` — same behavior, new source.

---

## 4. Counts & Aggregation Layer

Pure functions over `Burn0Event[]`. No I/O, no state — trivially unit-testable
and shared verbatim by the TUI, `burn0 report`, `burn0 today`, and the future
web dashboard.

### 4.1 Endpoint normalization

`src/query/normalize.ts`:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH_RE = /^[0-9a-f]{16,}$/i
const NUM_RE = /^\d+$/
// ids like "cus_Pf83k2", "evt_ly2k9frq" — short prefix + long opaque tail
const PREFIXED_ID_RE = /^[a-z]{2,6}_[a-zA-Z0-9]{8,}$/

export function normalizeEndpoint(rawPath: string): string {
  const clean = rawPath.split("?")[0].split("#")[0]
  const segments = clean.split("/").map((seg) => {
    if (NUM_RE.test(seg)) return ":id"
    if (UUID_RE.test(seg)) return ":uuid"
    if (HASH_RE.test(seg)) return ":hash"
    if (PREFIXED_ID_RE.test(seg)) return ":id"
    return seg
  })
  const out = segments.join("/")
  return out === "" ? "/" : out
}
```

Examples: `/v1/users/8231?expand=1` → `/v1/users/:id`,
`/rest/v1/orders/550e8400-e29b-41d4-a716-446655440000` → `/rest/v1/orders/:uuid`,
`/v1/customers/cus_Pf83k2xQ91Lm` → `/v1/customers/:id`.

Normalization runs **at capture time** (interceptor), so stored events are
already grouped and no raw high-cardinality paths accumulate.

### 4.2 Aggregation

`src/query/aggregate.ts`:

```ts
import type { Burn0Event } from "../types"

export interface LatencyStats {
  avg: number
  p50: number
  p95: number
  p99: number
}

export interface Summary {
  calls: number
  errors: number
  errorRate: number // 0..1
  latency: LatencyStats
  tokensIn: number
  tokensOut: number
  services: ServiceRollup[]
}

export interface ServiceRollup {
  service: string
  isLlm: boolean
  calls: number
  errors: number
  errorRate: number
  latency: LatencyStats
  tokensIn: number
  tokensOut: number
  /** null until pricing lands (D2) — TUI renders "—" */
  costUsd: number | null
}

export interface EndpointRollup {
  method: string
  endpoint: string
  calls: number
  errors: number
  errorRate: number
  latency: LatencyStats
  statusCounts: Record<number, number>
}

export interface ModelRollup {
  model: string
  calls: number
  tokensIn: number
  tokensOut: number
  costUsd: number | null
}

const isError = (e: Burn0Event) => e.status_code === 0 || e.status_code >= 400

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

export function latencyStats(events: Burn0Event[]): LatencyStats {
  if (events.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0 }
  const durs = events.map((e) => e.duration_ms).sort((a, b) => a - b)
  const sum = durs.reduce((a, b) => a + b, 0)
  return {
    avg: sum / durs.length,
    p50: percentile(durs, 50),
    p95: percentile(durs, 95),
    p99: percentile(durs, 99),
  }
}

function groupBy<K extends string>(events: Burn0Event[], key: (e: Burn0Event) => K) {
  const map = new Map<K, Burn0Event[]>()
  for (const e of events) {
    const k = key(e)
    const arr = map.get(k)
    if (arr) arr.push(e)
    else map.set(k, [e])
  }
  return map
}

const isLlmEvent = (e: Burn0Event) => e.tokens_in !== undefined || e.model !== undefined

export function serviceRollups(events: Burn0Event[]): ServiceRollup[] {
  const out: ServiceRollup[] = []
  for (const [service, evs] of groupBy(events, (e) => e.service)) {
    const errors = evs.filter(isError).length
    out.push({
      service,
      isLlm: evs.some(isLlmEvent),
      calls: evs.length,
      errors,
      errorRate: errors / evs.length,
      latency: latencyStats(evs),
      tokensIn: evs.reduce((a, e) => a + (e.tokens_in ?? 0), 0),
      tokensOut: evs.reduce((a, e) => a + (e.tokens_out ?? 0), 0),
      costUsd: null, // pricing seam (§8)
    })
  }
  // LLM entities first (cost/tokens are the hero), then by call volume
  return out.sort((a, b) => Number(b.isLlm) - Number(a.isLlm) || b.calls - a.calls)
}

export function summarize(events: Burn0Event[]): Summary {
  const errors = events.filter(isError).length
  return {
    calls: events.length,
    errors,
    errorRate: events.length ? errors / events.length : 0,
    latency: latencyStats(events),
    tokensIn: events.reduce((a, e) => a + (e.tokens_in ?? 0), 0),
    tokensOut: events.reduce((a, e) => a + (e.tokens_out ?? 0), 0),
    services: serviceRollups(events),
  }
}

export function endpointRollups(events: Burn0Event[], service: string): EndpointRollup[] {
  const evs = events.filter((e) => e.service === service)
  const out: EndpointRollup[] = []
  for (const [key, group] of groupBy(evs, (e) => `${e.method} ${e.endpoint}` as string)) {
    const [method, ...rest] = key.split(" ")
    const errors = group.filter(isError).length
    const statusCounts: Record<number, number> = {}
    for (const e of group) statusCounts[e.status_code] = (statusCounts[e.status_code] ?? 0) + 1
    out.push({
      method,
      endpoint: rest.join(" "),
      calls: group.length,
      errors,
      errorRate: errors / group.length,
      latency: latencyStats(group),
      statusCounts,
    })
  }
  return out.sort((a, b) => b.calls - a.calls)
}

export function modelRollups(events: Burn0Event[], service: string): ModelRollup[] {
  const evs = events.filter((e) => e.service === service && e.model)
  const out: ModelRollup[] = []
  for (const [model, group] of groupBy(evs, (e) => e.model as string)) {
    out.push({
      model,
      calls: group.length,
      tokensIn: group.reduce((a, e) => a + (e.tokens_in ?? 0), 0),
      tokensOut: group.reduce((a, e) => a + (e.tokens_out ?? 0), 0),
      costUsd: null,
    })
  }
  return out.sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut))
}

/** Call counts bucketed over [sinceMs, untilMs) — feeds sparklines. */
export function timeBuckets(
  events: Burn0Event[],
  sinceMs: number,
  untilMs: number,
  buckets = 30,
): number[] {
  const out = new Array<number>(buckets).fill(0)
  const span = untilMs - sinceMs
  if (span <= 0) return out
  for (const e of events) {
    const t = Date.parse(e.timestamp)
    if (t < sinceMs || t >= untilMs) continue
    out[Math.min(buckets - 1, Math.floor(((t - sinceMs) / span) * buckets))]++
  }
  return out
}
```

### 4.3 Time windows

The TUI and CLI share one window model:

```ts
export type WindowKey = "today" | "24h" | "7d" | "30d"

export function windowRange(key: WindowKey, now = Date.now()): { sinceMs: number; untilMs: number } {
  switch (key) {
    case "today": {
      const d = new Date(now)
      return { sinceMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), untilMs: now }
    }
    case "24h":
      return { sinceMs: now - 86_400_000, untilMs: now }
    case "7d":
      return { sinceMs: now - 7 * 86_400_000, untilMs: now }
    case "30d":
      return { sinceMs: now - 30 * 86_400_000, untilMs: now }
  }
}
```

---

## 5. Payload Store (Phase 3, opt-in)

Off by default; `BURN0_CAPTURE_BODIES=1` enables it. One JSON file per event,
under a day directory so retention stays file-deletion (§3.6). 1 MB per-body
cap with a `truncated` flag. Authorization/cookie/api-key headers are redacted
at capture time — payloads on disk never contain credentials, removing Draft
0.1's open question #3.

`src/store/payloads.ts`:

```ts
import fs from "node:fs"
import path from "node:path"
import { projectDir, utcDay } from "./paths"

const BODY_CAP = 1024 * 1024 // 1 MB
const REDACT_HEADERS = new Set([
  "authorization", "cookie", "set-cookie", "x-api-key", "api-key",
  "x-goog-api-key", "anthropic-api-key", "openai-api-key", "proxy-authorization",
])

export interface Payload {
  event_id: string
  req_headers: Record<string, string>
  req_body: string
  req_truncated: boolean
  res_headers: Record<string, string>
  res_body: string
  res_truncated: boolean
  stack_snippet?: string
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v
  }
  return out
}

export function capBody(body: string): { body: string; truncated: boolean } {
  return body.length > BODY_CAP
    ? { body: body.slice(0, BODY_CAP), truncated: true }
    : { body, truncated: false }
}

export function payloadPath(slug: string, eventId: string, tsMs: number): string {
  return path.join(projectDir(slug), "payloads", utcDay(tsMs), `${eventId}.json`)
}

export function writePayload(slug: string, tsMs: number, p: Payload): void {
  try {
    const file = payloadPath(slug, p.event_id, tsMs)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(p))
  } catch {} // never fatal
}

export function readPayload(slug: string, eventId: string, tsMs: number): Payload | null {
  try {
    return JSON.parse(fs.readFileSync(payloadPath(slug, eventId, tsMs), "utf-8"))
  } catch {
    return null
  }
}
```

The Request Detail screen (§6.9) renders the payload when present and a
"body capture is off — set BURN0_CAPTURE_BODIES=1" hint when not.

---

## 6. TUI

### 6.1 Stack & constraints

- **Ink 5 + React 18** (`ink`, `react` as dependencies). Ink 5 is ESM-only:
  the CLI bundle switches to ESM output in `tsup.config.ts` (`format: ['esm']`
  for the `cli` and `tui` entries; the SDK entry keeps dual CJS/ESM).
- TUI requires a TTY with raw mode. Non-TTY (`burn0 | tee`, CI): print the
  `report` output instead and exit — never hang.
- The TUI is a **pure reader**: it opens the store read-only, works with or
  without the app running, and renders the empty-state onboarding when the
  project has no events yet.

### 6.2 Screens & navigation

```
┌ Overview ┐┌ Entities ┐┌ LLM ┐┌ API ┐┌ Live ┐        my-api · 30d
```

| Key | Action |
|---|---|
| `←`/`→` or `1`–`5` | switch screen |
| `↑`/`↓` | move selection in the active table |
| `Enter` | drill in (Overview→Entity, trace→Request Detail) |
| `Esc` | back out of detail |
| `t` | cycle time window: today → 24h → 7d → 30d |
| `p` | project switcher (registry list) |
| `r` | force reload |
| `q` / `Ctrl-C` | quit |

### 6.3 Theme & formatting

`src/tui/theme.ts`:

```ts
export const color = {
  accent: "#ff6b35", // burn0 orange
  dim: "gray",
  ok: "green",
  warn: "yellow",
  err: "red",
} as const

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 10_000) return Math.round(n / 1000) + "k"
  if (n >= 1_000) return (n / 1000).toFixed(1) + "k"
  return String(n)
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms"
}

export function fmtPct(rate: number): string {
  return (rate * 100).toFixed(1) + "%"
}

export function fmtCost(usd: number | null): string {
  if (usd === null) return "—" // pricing deferred (D2)
  return usd < 0.01 && usd > 0 ? "<$0.01" : "$" + usd.toFixed(2)
}

const SPARK = "▁▂▃▄▅▆▇█"
export function sparkline(buckets: number[]): string {
  const max = Math.max(...buckets, 1)
  return buckets.map((v) => SPARK[Math.min(7, Math.round((v / max) * 7))]).join("")
}
```

### 6.4 Data hook — load + refresh

Cold-load the window once, then cheaply refresh by watching the events
directory (new appends touch today's segment; day rollover creates a file —
both fire the watcher). A 2 s debounce keeps re-reads sane under load.

`src/tui/hooks/useEvents.ts`:

```tsx
import { useEffect, useMemo, useState } from "react"
import fs from "node:fs"
import type { Burn0Event } from "../../types"
import { readRange } from "../../store/segments"
import { eventsDir } from "../../store/paths"
import { windowRange, type WindowKey } from "../../query/aggregate"

export function useEvents(slug: string, window: WindowKey) {
  const [events, setEvents] = useState<Burn0Event[]>([])
  const [skipped, setSkipped] = useState(0)
  const [version, setVersion] = useState(0) // bump to force reload

  useEffect(() => {
    const { sinceMs, untilMs } = windowRange(window)
    const res = readRange(slug, sinceMs, untilMs)
    setEvents(res.events)
    setSkipped(res.skippedLines)
  }, [slug, window, version])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: fs.FSWatcher | null = null
    try {
      watcher = fs.watch(eventsDir(slug), () => {
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          setVersion((v) => v + 1)
        }, 2000)
      })
    } catch {} // dir may not exist yet — empty state handles it
    return () => {
      watcher?.close()
      if (timer) clearTimeout(timer)
    }
  }, [slug])

  const reload = () => setVersion((v) => v + 1)
  return useMemo(() => ({ events, skipped, reload }), [events, skipped])
}
```

### 6.5 Live tail hook

The Live screen needs event-granular updates, not window re-reads: track a
byte offset into today's segment, read only appended bytes, handle midnight
rollover, and fall back to 1 s polling where `fs.watch` is unreliable.

`src/tui/hooks/useTail.ts`:

```tsx
import { useEffect, useRef, useState } from "react"
import fs from "node:fs"
import type { Burn0Event } from "../../types"
import { segmentPath, utcDay } from "../../store/paths"

const MAX_LIVE_ROWS = 500

export function useTail(slug: string): Burn0Event[] {
  const [rows, setRows] = useState<Burn0Event[]>([])
  const state = useRef({ day: "", offset: 0, partial: "" })

  useEffect(() => {
    const pump = () => {
      const day = utcDay(Date.now())
      const s = state.current
      if (s.day !== day) {
        // midnight rollover — start tailing the new segment from 0
        s.day = day
        s.offset = 0
        s.partial = ""
      }
      const file = segmentPath(slug, day)
      let size: number
      try {
        size = fs.statSync(file).size
      } catch {
        return // no segment yet today
      }
      if (size <= s.offset) return
      let fd: number
      try {
        fd = fs.openSync(file, "r")
      } catch {
        return
      }
      try {
        const buf = Buffer.alloc(size - s.offset)
        fs.readSync(fd, buf, 0, buf.length, s.offset)
        s.offset = size
        const text = s.partial + buf.toString("utf-8")
        const lines = text.split("\n")
        s.partial = lines.pop() ?? "" // keep torn tail for next pump
        const fresh: Burn0Event[] = []
        for (const line of lines) {
          if (!line) continue
          try {
            fresh.push(JSON.parse(line))
          } catch {}
        }
        if (fresh.length) {
          setRows((prev) => [...prev, ...fresh].slice(-MAX_LIVE_ROWS))
        }
      } finally {
        fs.closeSync(fd)
      }
    }

    // On mount: start from the current end (a live view, not history)
    try {
      const day = utcDay(Date.now())
      state.current = { day, offset: fs.statSync(segmentPath(slug, day)).size, partial: "" }
    } catch {
      state.current = { day: utcDay(Date.now()), offset: 0, partial: "" }
    }

    const interval = setInterval(pump, 1000)
    let watcher: fs.FSWatcher | null = null
    try {
      watcher = fs.watch(segmentPath(slug, utcDay(Date.now())), pump)
    } catch {}
    return () => {
      clearInterval(interval)
      watcher?.close()
    }
  }, [slug])

  return rows
}
```

### 6.6 App shell

`src/tui/App.tsx`:

```tsx
import React, { useState } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { TabBar } from "./components/TabBar"
import { Overview } from "./screens/Overview"
import { EntityDetail } from "./screens/EntityDetail"
import { LlmTraces } from "./screens/LlmTraces"
import { ApiTraces } from "./screens/ApiTraces"
import { Live } from "./screens/Live"
import { RequestDetail } from "./screens/RequestDetail"
import { useEvents } from "./hooks/useEvents"
import type { Burn0Event } from "../types"
import type { WindowKey } from "../query/aggregate"
import { color } from "./theme"

const TABS = ["Overview", "Entities", "LLM", "API", "Live"] as const
const WINDOWS: WindowKey[] = ["today", "24h", "7d", "30d"]

export function App({ slug, projectName }: { slug: string; projectName: string }) {
  const { exit } = useApp()
  const [tab, setTab] = useState(0)
  const [window, setWindow] = useState<WindowKey>("30d")
  const [entity, setEntity] = useState<string | null>(null)
  const [detail, setDetail] = useState<Burn0Event | null>(null)
  const { events, skipped, reload } = useEvents(slug, window)

  useInput((input, key) => {
    if (input === "q") exit()
    if (detail) {
      if (key.escape) setDetail(null)
      return // detail screen swallows navigation
    }
    if (key.escape && entity !== null) return setEntity(null)
    if (key.leftArrow) setTab((t) => (t + TABS.length - 1) % TABS.length)
    if (key.rightArrow) setTab((t) => (t + 1) % TABS.length)
    const n = Number(input)
    if (n >= 1 && n <= TABS.length) setTab(n - 1)
    if (input === "t") setWindow((w) => WINDOWS[(WINDOWS.indexOf(w) + 1) % WINDOWS.length])
    if (input === "r") reload()
  })

  const screen = detail ? (
    <RequestDetail slug={slug} event={detail} />
  ) : entity !== null ? (
    <EntityDetail events={events} service={entity} onOpen={setDetail} />
  ) : (
    [
      <Overview key="o" events={events} window={window} onDrill={(s) => setEntity(s)} />,
      <Overview key="e" events={events} window={window} onDrill={(s) => setEntity(s)} entitiesOnly />,
      <LlmTraces key="l" events={events} onOpen={setDetail} />,
      <ApiTraces key="a" events={events} onOpen={setDetail} />,
      <Live key="v" slug={slug} onOpen={setDetail} />,
    ][tab]
  )

  return (
    <Box flexDirection="column">
      <TabBar tabs={TABS} active={tab} projectName={projectName} window={window} />
      {events.length === 0 && tab !== 4 ? <EmptyState /> : screen}
      <Box>
        <Text color={color.dim}>
          {" ←/→ screens · ↑/↓ select · Enter open · t window · r reload · q quit"}
          {skipped > 0 ? `  (${skipped} unreadable lines skipped)` : ""}
        </Text>
      </Box>
    </Box>
  )
}

function EmptyState() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>No requests recorded yet for this project.</Text>
      <Text> </Text>
      <Text>1. Add to the top of your entry file:  <Text color={color.accent}>import "@burn0/burn0"</Text></Text>
      <Text>2. Run your app and make some API calls.</Text>
      <Text>3. Come back here — data appears automatically.</Text>
      <Text> </Text>
      <Text color={color.dim}>Or run without code changes:  npx burn0 dev -- node app.js</Text>
    </Box>
  )
}
```

### 6.7 Generic selectable table

Every list screen uses one component: column definitions, `↑/↓` selection,
`Enter` callback, viewport windowing so thousand-row lists stay fast.

`src/tui/components/Table.tsx`:

```tsx
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import { color } from "../theme"

export interface Column<T> {
  title: string
  width: number
  align?: "left" | "right"
  render: (row: T) => string
  color?: (row: T) => string | undefined
}

export function Table<T>({
  rows,
  columns,
  onEnter,
  height = 15,
  active = true,
}: {
  rows: T[]
  columns: Column<T>[]
  onEnter?: (row: T) => void
  height?: number
  active?: boolean
}) {
  const [sel, setSel] = useState(0)
  const clamped = Math.min(sel, Math.max(0, rows.length - 1))

  useInput(
    (_input, key) => {
      if (key.upArrow) setSel((s) => Math.max(0, s - 1))
      if (key.downArrow) setSel((s) => Math.min(rows.length - 1, s + 1))
      if (key.return && onEnter && rows[clamped]) onEnter(rows[clamped])
    },
    { isActive: active },
  )

  const top = Math.max(0, Math.min(clamped - Math.floor(height / 2), rows.length - height))
  const visible = rows.slice(top, top + height)

  const pad = (s: string, w: number, align: "left" | "right" = "left") => {
    const t = s.length > w ? s.slice(0, w - 1) + "…" : s
    return align === "right" ? t.padStart(w) : t.padEnd(w)
  }

  return (
    <Box flexDirection="column">
      <Text color={color.dim} bold>
        {"  " + columns.map((c) => pad(c.title, c.width, c.align)).join(" ")}
      </Text>
      {visible.map((row, i) => {
        const isSel = top + i === clamped
        return (
          <Text key={top + i} inverse={isSel && active}>
            {(isSel ? "> " : "  ") +
              columns.map((c) => pad(c.render(row), c.width, c.align)).join(" ")}
          </Text>
        )
      })}
      {rows.length > height && (
        <Text color={color.dim}>{`  ${clamped + 1}/${rows.length}`}</Text>
      )}
    </Box>
  )
}
```

### 6.8 Screens

**Overview** — metric strip + sparkline + entity table. Target render:

```
 CALLS 1,204      ERRORS 1.2%      AVG 342ms       TOKENS 1.2M
 ▁▂▂▃▅▄▃▂▁▁▂▃▄▆█▅▃▂▁▁▂▂▃▃▄▃▂▁▁▂                       last 30d

  SERVICE          CALLS    ERR%     P95     TOKENS     COST
> openai             820    0.4%    1.2s      1.1M        —
  supabase           301    2.1%   210ms         —        —
  stripe              83    0.0%   180ms         —        —
```

`src/tui/screens/Overview.tsx`:

```tsx
import React from "react"
import { Box, Text } from "ink"
import { summarize, timeBuckets, windowRange, type WindowKey } from "../../query/aggregate"
import type { Burn0Event } from "../../types"
import { Table, type Column } from "../components/Table"
import { color, fmtCost, fmtMs, fmtNum, fmtPct, sparkline } from "../theme"
import type { ServiceRollup } from "../../query/aggregate"

export function Overview({
  events,
  window,
  onDrill,
  entitiesOnly = false,
}: {
  events: Burn0Event[]
  window: WindowKey
  onDrill: (service: string) => void
  entitiesOnly?: boolean
}) {
  const s = summarize(events)
  const { sinceMs, untilMs } = windowRange(window)

  const columns: Column<ServiceRollup>[] = [
    { title: "SERVICE", width: 18, render: (r) => r.service },
    { title: "CALLS", width: 7, align: "right", render: (r) => fmtNum(r.calls) },
    {
      title: "ERR%", width: 6, align: "right",
      render: (r) => fmtPct(r.errorRate),
      color: (r) => (r.errorRate > 0.05 ? color.err : undefined),
    },
    { title: "P95", width: 7, align: "right", render: (r) => fmtMs(r.latency.p95) },
    {
      title: "TOKENS", width: 8, align: "right",
      render: (r) => (r.isLlm ? fmtNum(r.tokensIn + r.tokensOut) : "—"),
    },
    { title: "COST", width: 8, align: "right", render: (r) => fmtCost(r.costUsd) },
  ]

  return (
    <Box flexDirection="column" paddingX={1}>
      {!entitiesOnly && (
        <>
          <Box gap={4} marginY={1}>
            <Metric label="CALLS" value={fmtNum(s.calls)} />
            <Metric label="ERRORS" value={fmtPct(s.errorRate)} warn={s.errorRate > 0.05} />
            <Metric label="AVG" value={fmtMs(s.latency.avg)} />
            <Metric label="TOKENS" value={fmtNum(s.tokensIn + s.tokensOut)} />
          </Box>
          <Text color={color.accent}>{sparkline(timeBuckets(events, sinceMs, untilMs))}</Text>
        </>
      )}
      <Box marginTop={1}>
        <Table rows={s.services} columns={columns} onEnter={(r) => onDrill(r.service)} />
      </Box>
    </Box>
  )
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <Box flexDirection="column">
      <Text color={color.dim}>{label}</Text>
      <Text bold color={warn ? color.err : undefined}>{value}</Text>
    </Box>
  )
}
```

**Entity Detail** — endpoint breakdown for any service; model split appended
for LLM services:

```tsx
// src/tui/screens/EntityDetail.tsx
import React from "react"
import { Box, Text } from "ink"
import { endpointRollups, modelRollups } from "../../query/aggregate"
import type { Burn0Event } from "../../types"
import { Table, type Column } from "../components/Table"
import { color, fmtMs, fmtNum, fmtPct, fmtCost } from "../theme"
import type { EndpointRollup } from "../../query/aggregate"

export function EntityDetail({
  events,
  service,
  onOpen,
}: {
  events: Burn0Event[]
  service: string
  onOpen: (e: Burn0Event) => void
}) {
  const endpoints = endpointRollups(events, service)
  const models = modelRollups(events, service)

  const cols: Column<EndpointRollup>[] = [
    { title: "METHOD", width: 7, render: (r) => r.method },
    { title: "ENDPOINT", width: 34, render: (r) => r.endpoint },
    { title: "CALLS", width: 7, align: "right", render: (r) => fmtNum(r.calls) },
    { title: "ERR%", width: 6, align: "right", render: (r) => fmtPct(r.errorRate) },
    { title: "P50", width: 7, align: "right", render: (r) => fmtMs(r.latency.p50) },
    { title: "P95", width: 7, align: "right", render: (r) => fmtMs(r.latency.p95) },
  ]

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={color.accent}>{service}</Text>
      <Table
        rows={endpoints}
        columns={cols}
        onEnter={(r) => {
          const latest = events.filter(
            (e) => e.service === service && e.endpoint === r.endpoint && e.method === r.method,
          ).at(-1)
          if (latest) onOpen(latest)
        }}
      />
      {models.length > 0 && (
        <>
          <Box marginTop={1}><Text color={color.dim} bold>  MODELS</Text></Box>
          {models.map((m) => (
            <Text key={m.model}>
              {"  " + m.model.padEnd(28)}
              {fmtNum(m.calls).padStart(6)} calls
              {("  in " + fmtNum(m.tokensIn)).padEnd(12)}
              {("out " + fmtNum(m.tokensOut)).padEnd(12)}
              {fmtCost(m.costUsd).padStart(8)}
            </Text>
          ))}
        </>
      )}
      <Text color={color.dim}>{"\n  Esc back"}</Text>
    </Box>
  )
}
```

**LLM Traces / API Traces** — two filters over one trace-table pattern:

```tsx
// src/tui/screens/LlmTraces.tsx
import React from "react"
import type { Burn0Event } from "../../types"
import { Table, type Column } from "../components/Table"
import { fmtMs, fmtNum, fmtCost } from "../theme"

const timeOf = (e: Burn0Event) => e.timestamp.slice(11, 19)

export function LlmTraces({ events, onOpen }: { events: Burn0Event[]; onOpen: (e: Burn0Event) => void }) {
  const rows = events.filter((e) => e.model !== undefined).slice(-1000).reverse()
  const cols: Column<Burn0Event>[] = [
    { title: "TIME", width: 8, render: timeOf },
    { title: "SERVICE", width: 11, render: (e) => e.service },
    { title: "MODEL", width: 24, render: (e) => e.model ?? "" },
    { title: "IN", width: 7, align: "right", render: (e) => fmtNum(e.tokens_in ?? 0) },
    { title: "OUT", width: 7, align: "right", render: (e) => fmtNum(e.tokens_out ?? 0) },
    { title: "MS", width: 7, align: "right", render: (e) => fmtMs(e.duration_ms) },
    { title: "COST", width: 8, align: "right", render: () => fmtCost(null) },
    { title: "FEAT", width: 12, render: (e) => e.feature ?? "" },
  ]
  return <Table rows={rows} columns={cols} onEnter={onOpen} height={18} />
}
```

`ApiTraces.tsx` is identical with the inverse filter
(`e.model === undefined`) and columns `TIME · SERVICE · METHOD · ENDPOINT ·
STATUS · MS` (status colored green/yellow/red by class).

**Live** — DevTools-style tail built on `useTail` (§6.5), same trace columns,
auto-following the newest row, `Enter` jumps to Request Detail:

```tsx
// src/tui/screens/Live.tsx
import React from "react"
import { Box, Text } from "ink"
import { useTail } from "../hooks/useTail"
import type { Burn0Event } from "../../types"
import { Table, type Column } from "../components/Table"
import { color, fmtMs } from "../theme"

export function Live({ slug, onOpen }: { slug: string; onOpen: (e: Burn0Event) => void }) {
  const rows = useTail(slug)
  const cols: Column<Burn0Event>[] = [
    { title: "TIME", width: 8, render: (e) => e.timestamp.slice(11, 19) },
    { title: "SERVICE", width: 12, render: (e) => e.service },
    { title: "METHOD", width: 7, render: (e) => e.method },
    { title: "ENDPOINT", width: 30, render: (e) => e.endpoint },
    {
      title: "STATUS", width: 7, align: "right",
      render: (e) => String(e.status_code),
      color: (e) => (e.status_code >= 500 ? color.err : e.status_code >= 400 ? color.warn : color.ok),
    },
    { title: "MS", width: 7, align: "right", render: (e) => fmtMs(e.duration_ms) },
  ]
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={color.dim}>
        {rows.length === 0 ? "  waiting for requests… (run your app in another terminal)" : ""}
      </Text>
      <Table rows={[...rows].reverse()} columns={cols} onEnter={onOpen} height={18} />
    </Box>
  )
}
```

### 6.9 Request Detail

Everything known about one event; payload section renders when Phase 3 capture
was on for that request:

```tsx
// src/tui/screens/RequestDetail.tsx
import React from "react"
import { Box, Text } from "ink"
import type { Burn0Event } from "../../types"
import { readPayload } from "../../store/payloads"
import { color, fmtMs } from "../theme"

export function RequestDetail({ slug, event }: { slug: string; event: Burn0Event }) {
  const payload = readPayload(slug, event.id, Date.parse(event.timestamp))
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={color.accent}>{`${event.method} ${event.host}${event.endpoint}`}</Text>
      <Text>{`  ${event.timestamp} · ${event.status_code} · ${fmtMs(event.duration_ms)} · ${event.service}`}</Text>
      {event.model && (
        <Text>{`  model ${event.model} · tokens in ${event.tokens_in ?? "?"} out ${event.tokens_out ?? "?"}${event.tokens_cached ? ` cached ${event.tokens_cached}` : ""}`}</Text>
      )}
      {event.feature && <Text>{`  feature: ${event.feature}`}</Text>}
      {payload ? (
        <>
          <Text color={color.dim} bold>{"\n  REQUEST" + (payload.req_truncated ? "  (truncated at 1MB)" : "")}</Text>
          <Text wrap="truncate-end">{"  " + payload.req_body.slice(0, 4000)}</Text>
          <Text color={color.dim} bold>{"\n  RESPONSE" + (payload.res_truncated ? "  (truncated at 1MB)" : "")}</Text>
          <Text wrap="truncate-end">{"  " + payload.res_body.slice(0, 4000)}</Text>
          {payload.stack_snippet && (
            <>
              <Text color={color.dim} bold>{"\n  CALLED FROM"}</Text>
              <Text color={color.dim}>{"  " + payload.stack_snippet}</Text>
            </>
          )}
        </>
      ) : (
        <Text color={color.dim}>{"\n  Bodies not captured. Set BURN0_CAPTURE_BODIES=1 to store request/response payloads (kept 7 days, secrets redacted)."}</Text>
      )}
      <Text color={color.dim}>{"\n  Esc back"}</Text>
    </Box>
  )
}
```

### 6.10 TUI entry

`src/tui/main.tsx`:

```tsx
import React from "react"
import { render } from "ink"
import { App } from "./App"
import { resolveProject, listProjects } from "../store/project"
import { pruneIfDue } from "../store/retention"
import { migrateLegacyLedger } from "../store/migrate"

export async function runTui(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Non-interactive: degrade to the report, never hang a pipe
    const { runReport } = await import("../cli/report")
    await runReport({})
    return
  }
  const project = resolveProject()
  migrateLegacyLedger(process.cwd(), project.slug)
  pruneIfDue(project.slug)

  // If cwd has no burn0 data but other projects exist, still open —
  // the `p` key lists projects from the registry (listProjects()).
  const { waitUntilExit } = render(<App slug={project.slug} projectName={project.name} />)
  await waitUntilExit()
}
```

---

## 7. CLI Changes

`src/cli/index.ts` additions (existing commands unchanged):

```ts
// default action: `burn0` with no subcommand opens the TUI
program.action(async () => {
  const { runTui } = await import("../tui/main")
  await runTui()
})

program
  .command("today")
  .description("One-shot summary of today's calls, tokens, and top services")
  .action(async () => {
    const { runToday } = await import("./today")
    await runToday()
  })

program
  .command("watch")
  .description("Live tail of requests (opens the TUI on the Live screen)")
  .action(async () => {
    const { runTui } = await import("../tui/main")
    await runTui({ screen: "live" })
  })

program
  .command("export")
  .description("Dump events to stdout as JSON or CSV")
  .option("--format <fmt>", "json | csv", "json")
  .option("--days <n>", "window in days", "30")
  .action(async (opts) => {
    const { runExport } = await import("./export")
    await runExport(opts)
  })
```

`burn0 today` (`src/cli/today.ts`) — the scriptable one-shot, built on the
same aggregation layer:

```ts
import { resolveProject } from "../store/project"
import { readRange } from "../store/segments"
import { summarize, windowRange } from "../query/aggregate"
import { fmtNum, fmtPct, fmtMs } from "../tui/theme"

export async function runToday(): Promise<void> {
  const project = resolveProject()
  const { sinceMs, untilMs } = windowRange("today")
  const { events } = readRange(project.slug, sinceMs, untilMs)
  const s = summarize(events)

  console.log(`burn0 · ${project.name} · today\n`)
  console.log(
    `  ${fmtNum(s.calls)} calls · ${fmtPct(s.errorRate)} errors · avg ${fmtMs(s.latency.avg)} · ${fmtNum(s.tokensIn + s.tokensOut)} tokens\n`,
  )
  for (const svc of s.services.slice(0, 10)) {
    console.log(
      `  ${svc.service.padEnd(18)} ${fmtNum(svc.calls).padStart(6)} calls  ${
        svc.isLlm ? fmtNum(svc.tokensIn + svc.tokensOut).padStart(8) + " tok" : "".padStart(12)
      }  p95 ${fmtMs(svc.latency.p95)}`,
    )
  }
  if (events.length === 0) console.log("  no requests recorded today")
}
```

`burn0 report` is rewired from `LocalLedger` to `readRange` + `summarize` —
output format unchanged except cost lines render `—` until pricing lands.

Command stability guarantee (carried from Draft 0.1): `today`, `report`,
`export`, `watch` keep their names and output contracts across the eventual
TUI→web default flip.

---

## 8. Pricing Seam (deferred — D2)

Everything cost-shaped goes through one interface so pricing can land later
without touching storage, aggregation, or the TUI:

```ts
// src/pricing/estimator.ts
import type { Burn0Event } from "../types"

export interface CostEstimator {
  /** null = cannot price (unknown service/model, or pricing not available) */
  estimate(event: Burn0Event): number | null
}

/** This milestone's only implementation. */
export const nullEstimator: CostEstimator = {
  estimate: () => null,
}
```

`ServiceRollup.costUsd` / `ModelRollup.costUsd` are computed by summing
`estimator.estimate(e)` per event (null-propagating); with `nullEstimator`
they are always `null` and every surface renders `—`. When pricing is decided
(bundled table vs. static-URL refresh), only a new `CostEstimator`
implementation and its wiring change.

The v0.2.x `fetchPricing` startup call to the backend is deleted as part of
this milestone (D2) — no network egress from the SDK in local mode, full stop.

---

## 9. Migration from v0.2.x

Legacy state: `<project>/.burn0/costs.jsonl` with schema v1 events (no `id`,
`host`, `method`, `project`). One-shot import, marker-guarded:

`src/store/migrate.ts`:

```ts
import fs from "node:fs"
import path from "node:path"
import type { Burn0Event } from "../types"
import { newEventId } from "../types"
import { SegmentStore } from "./segments"
import { projectDir } from "./paths"

export function migrateLegacyLedger(cwd: string, slug: string): void {
  try {
    const legacy = path.join(cwd, ".burn0", "costs.jsonl")
    const marker = path.join(projectDir(slug), ".migrated-v1")
    if (!fs.existsSync(legacy) || fs.existsSync(marker)) return

    const store = new SegmentStore(slug)
    for (const line of fs.readFileSync(legacy, "utf-8").split("\n")) {
      if (!line) continue
      try {
        const v1 = JSON.parse(line)
        const v2: Burn0Event = {
          schema_version: 2,
          id: newEventId(Date.parse(v1.timestamp) || Date.now()),
          project: slug,
          service: v1.service ?? "unknown",
          host: "",                     // not recorded in v1
          method: "",                   // not recorded in v1
          endpoint: v1.endpoint ?? "/",
          model: v1.model,
          tokens_in: v1.tokens_in,
          tokens_out: v1.tokens_out,
          status_code: v1.status_code ?? 0,
          timestamp: v1.timestamp,
          duration_ms: v1.duration_ms ?? 0,
          estimated: v1.estimated ?? false,
          feature: v1.feature,
          metadata: v1.metadata,
        }
        store.append(v2)
      } catch {} // skip bad lines
    }
    store.close()
    fs.mkdirSync(projectDir(slug), { recursive: true })
    fs.writeFileSync(marker, new Date().toISOString())
    // Legacy file is left in place (user's project dir — not ours to delete).
  } catch {}
}
```

Events land in the correct daily segments because `SegmentStore.append`
derives the segment from each event's own timestamp. The TUI shows empty
`host`/`method` for migrated rows — acceptable; they age out within 30 days.

---

## 10. Testing Plan

All new modules get unit tests mirroring the existing `tests/` layout:

| Module | Tests |
|---|---|
| `store/project` | slugify edge cases (`@scope/name`, unicode, empty); walk-up resolution; config override beats package.json; registry touch/list |
| `store/segments` | append→read round-trip; UTC day rollover mid-run; torn last line skipped and counted; concurrent appends from two child processes produce no corrupt lines; disk-error path disables without throwing |
| `store/retention` | files older than 30d deleted, newer kept; payload day-dirs at 7d; stamp throttling; missing dirs are no-ops |
| `store/migrate` | v1→v2 field mapping; marker prevents re-import; malformed lines skipped; legacy file untouched |
| `query/normalize` | numeric/UUID/hash/prefixed-id segments; query/fragment stripping; root path |
| `query/aggregate` | percentiles (incl. n=0, n=1); error-rate boundaries (status 0, 399/400/499/500); service ordering (LLM-first); endpoint & model rollups; timeBuckets boundary events |
| `tui/*` | `ink-testing-library`: Overview renders metrics from fixture events; Table selection clamps and windows; empty state renders onboarding; `q` exits; non-TTY entry falls back to report |
| `cli/today`, `cli/export` | snapshot output against fixture store (set `BURN0_HOME` to a temp dir) |

Existing interceptor/dispatcher tests are unaffected; `tests/transport/local.test.ts`
is superseded by `tests/store/segments.test.ts`.

Manual acceptance script: run a demo app making OpenAI + Supabase + unknown-host
calls, then verify (a) ticker totals match `burn0 today`, (b) TUI Overview
matches `burn0 report`, (c) Live screen shows requests within 1 s while the
demo runs in another terminal, (d) kill -9 the demo mid-burst and confirm the
TUI still opens and reports at most one skipped line.

---

## 11. Rollout Phases

| Phase | Scope | Ships as |
|---|---|---|
| **1 — Storage** | `store/*` (segments, project, retention, migrate), event schema v2, SDK wiring (§3.8), interceptors stamp `id/host/method`, remove `fetchPricing` startup call | v0.3.0 |
| **2 — Counts + TUI** | `query/*`, Ink app with Overview / Entities / LLM / API / Detail screens, `burn0` default → TUI, `burn0 today`, `report` rewired, `export` | v0.4.0 |
| **3 — Live + payloads** | `useTail` Live screen, `burn0 watch`, opt-in payload capture with redaction (§5), stack snippets | v0.5.0 |
| **4 — Pricing** *(deferred, separate spec)* | `CostEstimator` implementation, cost columns light up everywhere `fmtCost` already renders `—` | v0.6.0 |

Each phase is independently shippable; nothing in 1–3 blocks on any pricing
decision.

---

## 12. Explicitly Out of Scope

- Pricing/cost computation (Phase 4, separate decision — bundled table vs.
  static-URL refresh).
- Local web dashboard (`burn0 --web`) — same `store/` + `query/` layers will
  power it; nothing here needs rework for it.
- Cloud sync / team features — code parked per D1, untouched.
- Non-HTTP protocol capture — roadmap only, unchanged from Draft 0.1.
