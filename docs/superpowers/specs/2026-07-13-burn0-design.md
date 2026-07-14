# burn0 — Validated Design

**Date:** 2026-07-13
**Status:** Approved by Rafi (brainstorming session). Supersedes open questions in product spec Draft 0.1.
**Scope:** Full product per spec §1–10 — capture layer, storage, entities, pricing, config, CLI with 6-screen TUI. Web dashboard deferred (`--web` errors "coming soon").

## 1. Context & Decisions Summary

Fresh clean-room build in `burn0-1/` (prior `burn0/` v0.2.7 kept as reference only; proven patterns may be re-derived, not copied wholesale). Code pushed to existing git remote later; npm publish later — not part of this build.

| Open question (spec §11) | Decision |
|---|---|
| Q1 Pricing | Fetch LiteLLM pricing JSON on start, 24h-TTL cache at `~/.burn0/pricing.json`, bundled snapshot fallback. Never blocks capture. |
| Q2 Streaming | undici diagnostics_channel passive observation primary; `tee()` + 30s timeout on patched-fetch fallback (prior burn0's proven pattern). No buffer-then-replay. |
| Q3 Secrets | Redact by default before write (Authorization, api-key headers, cookie/set-cookie; `sk-…`/bearer patterns in bodies → `[redacted]`). Config: extra patterns, disable. |
| Q4 Monorepo/concurrency | WAL mode; per-service identity via nearest-package.json walk; explicit `project` config override. Concurrent-writer behavior covered by tests. |
| Q5 Production | Dev-only. `NODE_ENV=production` → auto-disable unless `BURN0_FORCE=1`. Serverless/edge → silent no-op. |
| Q6 Other runtimes | Bun/Deno/edge: silent no-op + one stderr line. Bun native support (bun:sqlite) on roadmap — storage behind adapter to enable it. |
| Q7 Config | Full shape in §7 below. |
| Q8 Failure matrix | §9 below. |
| Q9 Naming | README one-liner: "burn0 tracks your *application's* API spend and traffic locally — not your coding-agent usage (codeburn) and with no proxy (burnlens)." |
| Q10 Migrations | `schema_version` in `meta`; breaking mismatch → rename `burn0.db` → `burn0.db.bak`, create fresh. No migration code. |

## 2. Stack

- TypeScript, ESM+CJS dual output
- **better-sqlite3** behind a thin `StorageDriver` adapter (~30 lines) so `bun:sqlite` / `node:sqlite` can slot in later
- **Ink** (React) for the TUI
- **pnpm workspaces** monorepo (bun runtime support is roadmap, not tooling)
- **tsdown** bundler (Rolldown-based tsup successor), **vitest** tests

## 3. Repo Layout

```
burn0-1/
  package.json            # workspace root, private
  pnpm-workspace.yaml
  packages/
    core/                 # @burn0/core
      src/
        capture/          # dc subscriber, fetch patch, http patch, stream tee, dedup guard
        storage/          # StorageDriver adapter, schema, write queue, retention, redaction
        pricing/          # LiteLLM fetch + TTL cache + bundled snapshot, cost calc
        entities/         # hosts.ts table (extendable data file), endpoint normalization
        llm/              # provider detection, usage parsing (JSON + SSE variants)
        project/          # package.json walk, git root, override
        query/            # ALL aggregation/read API — CLI is a dumb renderer
        context/          # AsyncLocalStorage tag API (burn0.tag)
        config/           # burn0.config.json + env resolution
        register.ts       # side-effect entry
    cli/                  # burn0 bin — Ink screens + subcommands over core/query
  docs/superpowers/specs/
```

Publish shape (later): single `burn0` npm package bundling core + cli bin. Monorepo is dev structure only.

## 4. Capture Layer

Three interception layers, first-wins per request, deduplicated via WeakSet/correlation so dc + patches never double-record:

1. **undici diagnostics_channel** (primary): `undici:request:create/headers/trailers` + passive body-chunk observation. Covers native fetch and undici clients. Never wraps app stream objects.
2. **`globalThis.fetch` patch** (fallback): response body via `clone()` for JSON, `tee()` + 30s collect timeout for SSE. App branch returned immediately — first token never delayed; slow burn0 branch costs memory only, never stalls app.
3. **`http`/`https.request` patch**: covers axios, got, node-fetch. Passive event listeners accumulate chunks.

Per-request record: timestamp, method, URL, hostname, req/res headers+bodies (1MB cap + `truncated` flag), status, latency (start / first byte / complete), byte sizes, stack snippet (app frames only — burn0 and node_modules frames filtered), project id, ALS tags.

**LLM parsing:** hostname→provider table (OpenAI, Anthropic, Gemini, Mistral, Groq, Cohere, OpenRouter, Together, Fireworks, DeepSeek, xAI, …; more hosts added over time — table is a plain data file, one line per host). Model from request body, URL path (Gemini style), or response body. Usage from `usage` / `usageMetadata` / SSE final chunks (OpenAI last-chunk `usage`; Anthropic `message_delta`). Cached tokens captured where present. Aborted stream → store partial, `estimated=1`.

**Activation:** `import 'burn0'` or `node --import burn0/register`. Disabled when `BURN0_DISABLED=1`, or `NODE_ENV=production` without `BURN0_FORCE=1`, or non-Node runtime.

**Attribution API:** `burn0.tag({...})` via AsyncLocalStorage; tags attach to every request in the async context. Purely additive.

## 5. Storage

`~/.burn0/burn0.db` (override `BURN0_DB_PATH`), WAL mode, created on first use.

```sql
meta(key TEXT PRIMARY KEY, value TEXT)          -- schema_version, created_at, last_vacuum
projects(id INTEGER PRIMARY KEY, name TEXT UNIQUE, root_path TEXT, git_root TEXT, first_seen INTEGER)
requests(
  id INTEGER PRIMARY KEY, project_id INT, entity TEXT, provider TEXT,   -- provider NULL = non-LLM
  method TEXT, url TEXT, normalized_endpoint TEXT, hostname TEXT,
  status INT, started_at INT, first_byte_ms INT, latency_ms INT,
  req_bytes INT, res_bytes INT,
  model TEXT, tokens_in INT, tokens_out INT, tokens_cached INT, cost_usd REAL,
  estimated INT DEFAULT 0,
  tags TEXT                                      -- JSON
)
payloads(request_id INTEGER PRIMARY KEY REFERENCES requests(id),
  req_headers TEXT, req_body TEXT, res_headers TEXT, res_body TEXT,
  stack_snippet TEXT, req_truncated INT, res_truncated INT)
```

Indexes: `(project_id, started_at)`, `(entity, started_at)`, `(provider, model)`, `(started_at)`.

**Write path:** in-memory queue → batched transaction every 250ms or 100 events (setImmediate flush). Queue >5k pending → drop oldest, count. Redaction applied before write.

**Retention (on startup of app and CLI):** payloads >7d deleted; requests >30d deleted; `VACUUM` ~weekly via `meta.last_vacuum`. Config may lower/raise within ceilings (payloads ≤14d, metadata ≤90d).

**Cost:** computed at insert: `tokens_in×in_price + tokens_out×out_price + tokens_cached×cache_read_price` from in-memory pricing table. Unknown model → `cost_usd` NULL, shown "unpriced".

## 6. Entities & Project Identity

- Builtin host table (~40 entries at launch, grows over time): `{ hostPattern, entity, class: 'llm'|'general' }`. Unknown host → registrable domain as entity, class general.
- Endpoint normalization: numeric / UUID / ≥16-char-hex / base64-ish path segments → `:id`; query string dropped.
- LLM entities display cost as hero metric; general entities display call volume + error rate + latency, never cost.
- Project identity at init: config `project` → nearest `package.json` name → git root basename → cwd basename. Dedupe by name; git root stored as secondary key.

## 7. Configuration

`burn0.config.json` at project root, all optional:

```jsonc
{
  "project": "alif-backend",
  "retentionDays": { "payloads": 7, "metadata": 30 },   // ceilings 14 / 90
  "bodyCapBytes": 1048576,
  "ignoreHosts": ["localhost", "*.internal"],
  "capturePayloads": true,
  "redact": { "extraHeaders": [], "disable": false },
  "pricingTtlHours": 24,
  "dashboardPort": 4310                                  // reserved for web
}
```

Env (highest precedence): `BURN0_DISABLED`, `BURN0_FORCE`, `BURN0_DB_PATH`, `BURN0_PROJECT`. Invalid config values → warn once on stderr, fall back to default (never throw).

## 8. CLI & TUI

Commands: `burn0` (TUI default), `burn0 --cli`, `burn0 --web` (errors "coming soon"), `burn0 today` (one-shot summary), `burn0 watch` (live tail), `burn0 export --json|--csv` (metadata), `burn0 init` (writes config with defaults).

Ink TUI, tab row `[Overview] [Entities] [LLM] [API] [Network] [Debug]`, arrow keys, Enter drill-in, `q` quit:

1. **Overview** — strip: LLM spend 30d (today highlighted), total calls, error rate, avg latency; entity list sorted by cost/volume.
2. **Entity Detail** — normalized endpoint breakdown (calls, statuses, latency); LLM entities add per-model cost/token split.
3. **LLM Traces** — chronological, model/tokens/cost/latency/project; Enter → full prompt/response + stack snippet.
4. **API Traces** — same for general calls.
5. **Network** — live tail, polls db every 1s; Enter → stored detail.
6. **Debug/Request Detail** — headers, bodies, timing waterfall, code location.

Empty db → onboarding screen (install + import snippet). Footer: db size + internal error/drop counters. All aggregation in `core/query`; CLI renders only.

## 9. Failure Matrix

| Failure | Behavior |
|---|---|
| Any internal burn0 error | try/catch everywhere; app request proceeds untouched; error counter++ (shown in TUI footer) |
| DB locked/busy | 3 retries w/ backoff → drop batch, count |
| Disk full | disable writes for session, count |
| DB schema newer than lib/CLI | read-only if possible, else "upgrade burn0" message |
| Schema older (breaking) | rename db → `.bak`, fresh create |
| Another APM patched fetch | patch the wrapper anyway; dc path unaffected |
| Pricing fetch failure | TTL cache → bundled snapshot |
| No writable home dir | capture no-op, one stderr line |
| Stream aborted mid-flight | partial payload stored, `estimated=1` |

## 10. Testing Strategy

- **Unit** (vitest): endpoint normalization, redaction, usage parsing per provider fixture (JSON + SSE), cost calc, project resolution, config precedence, retention SQL.
- **Integration:** local HTTP server + real undici/fetch/axios/got clients → assert rows; SSE fixture streams → assert tee non-blocking + usage extraction; concurrent writers (2+ processes, WAL) test.
- **Failure injection:** locked db, full-ish disk simulation, malformed responses — app request must always succeed.

## 11. Direction (non-binding)

Today: dev-only tool — the first place a developer looks to understand their backend's LLM and API usage. Positioning shorthand: "local Sentry / local Datadog" — zero cloud, zero infra. Possible future (explicitly not in scope, informs naming/README only): coding-agent usage tracking; correlating agent spend with code shipped to branches (productivity estimation).

## 12. Explicitly Deferred

Web dashboard package; bun/deno native support; non-HTTP protocols; sampling/production posture; per-request pricing for non-LLM APIs; cloud/team features.
