# burn0 SDD progress (no-commit mode: review by working tree)
Core Task 1: complete (review found dts bug; fixed: tsdown ^0.22.7 + unrun, per-format dts .d.mts/.d.cts, package.json exports updated, no copy hack, register.ts entry deferred to Task 16)
NOTE for all later tasks: use tsdown ^0.22.7 + unrun devDep (plan says ^0.12.0 — outdated); ESM output is .mjs, types .d.mts
NOTE for Task 16: re-add 'src/register.ts' to tsdown entry; register export paths already .mjs/.cjs
Core Task 2: complete (review: removed 1 dead host rule; tests green)
Core Task 3: complete (review clean)
Core Task 4: complete (review clean; minor: nonNeg untested — noted for final review)
Core Task 5: complete (review clean)
Core Task 6: complete (review clean; minors noted). Core Task 7: complete (fix round 1: null-config crash, warn-once, bounded walk; re-review clean)
Core Task 8: complete (review clean; minor .bak-wal note for final review)
Core Task 9: complete (review clean; minor: maybeVacuum untested — noted for final review)
Core Task 10: complete (review clean)
Core Task 11: complete (review clean; minor: cap-order test gap — noted for final review)
Core Task 12: complete (fix round 1: reader cancel leak, guarded pre-processing, estimated flag; re-review clean; deferred: byte counts as string length, soft cap, narrow unhandled-rejection window in collect race)
Core Task 13: complete (review clean; inline: guarded res end callback; deferred: res error listener gap)
Core Task 14: complete (review clean)
Core Task 15: complete (review clean; nit: beforeId truthy check — noted for final review)
Core Task 16: complete (inline fix: per-step shutdown try/catch; review clean)
Core Task 17: complete (e2e; 2 legit source fixes: ClientRequest proto fallback, enrich gate removal; review clean). CORE PLAN DONE 17/17, 90 tests.
CLI Task 1: complete (review clean; stubs load-bearing for rolldown build)
CLI Task 2: complete (review clean)
CLI Task 3: complete (review clean)
CLI Task 4: complete (review clean)
CLI Task 5: complete (review clean)
CLI Task 6: complete (review clean)
CLI Task 7: complete (Ink5 async-input fix: tests tick around stdin.write; review clean). NOTE tasks 8-10: TUI tests must await tick before/after stdin.write
CLI Task 8: complete (review clean)
CLI Task 9: complete (review clean; minors: raw tags render, any-typed detail — noted for final review)
CLI Task 10: complete (review clean). CLI PLAN DONE 10/10. Total 119 tests green, pnpm -r build clean.
FINAL REVIEW: verdict ready after 1 fix. Fixed inline: res.on('error') emit (estimated=1) + emitOnce double-emit guard in both instrument paths. All other 11 minors triaged acceptable/non-issues.
Added packages/burn0-test (manual demo app: demo/stream/loop/tagged scripts, mock LLM server). Core: exported withTags+currentTags publicly; IP-hostname entity fix + test (91 core tests).
UI upgrade: fullscreen alt-screen mode + theme colors (theme.ts), numbered tabs, 0x0-pty guard in useTermSize. Verified: expect pty render + FORCE_COLOR truecolor codes. 29 cli tests green.
UI v2: full-width table system (ui.tsx: colWidths/TableRow/TableHeader/Card/Section/Rule), adaptive row counts, bordered metric cards, full-row selection, header rule + right-aligned req count. Tests 29 green.
Tabs reduced to Overview/Entities/LLM/API (numbers removed; Debug now Enter-drill overlay w/ esc; Network hidden). Overview: time window today/7d/30d via up/down (query.overview/entityList windowDays param, usePoll deps). Strict tab-switch test added. 92 core + 30 cli tests.
Overview selector focus: down enters window selector, left/right change today/7d/30d (tabs suppressed via subFocus), up/esc exit. Integration test added. 31 cli tests.
LLM test data: seed-llm script (10 realistic OpenAI/Anthropic/Gemini calls, real pricing, Q&A payloads). Debug: side-by-side Input/Output panels via llm-io.ts extractors (OpenAI/Anthropic/Gemini, JSON+SSE). requestDetail now selects tokens_cached + first_byte_ms. 42 cli tests. NOTE: expect-pty fragments escape sequences (arrows dead under expect only — real terminals single-chunk, component tests cover). Future idea (user): LangSmith-style sessions/runs with tool calls — plan later.

---
## 2026-07-26 — v1 spec + usage-tree slice

**Spec:** `docs/spec/2026-07-25-burn0-v1-spec.md` (~1000 lines). Settled: §1 projects/scoping, §2 runs & traces, §3 LLM pricing, §4 API usage, §7 entity names, §8 tool calls, §12 CLI/TUI. Deferred by user: §5/§6 (API pricing + cost engine) — "cost later". Not started: §9 tags, §10 budgets, §11 onboarding.

**Key decisions:** global DB + project filter, project = git root, service = nearest package.json · traces auto-root per inbound HTTP request, nested, trace-grouped default · LiteLLM as pricing source (evaluated 5 sources; day-1 coverage of new models) · API usage = request counts by endpoint, no product-name maps · show everything, no top-N or truncation · tabs = Overview · Usage · LLM · API · Logs.

**Verified empirically (Node 22.12), written up in §2.9:**
- `AsyncLocalStorage.enterWith()` in a diagnostics_channel subscriber is UNSAFE — nodejs/node#41978 open since 2022, maintainer says don't use it. `bindStore()` does not work on `http.server.request.start` (Node publishes without `runStores`).
- CORRECT mechanism: patch `emit` on **four** classes and wrap in `als.run()`. `https.Server` does NOT inherit from `http.Server`; patching only `http.Server` misses HTTPS and HTTP/2 entirely.
- Passed: sequential keep-alive, 60 concurrent/3 sockets, 10 pipelined single-write, post-response background work, Express 4.22 + Koa + bare http. 246 calls, 0 misattributed.
- KNOWN RISK, unfixed: SSE/streaming responses never fire `finish` → trace leaks in the pending map. High severity — LLM backends stream. Needs `close` listener + max-age sweep.

**Code landed (core only, CLI untouched):**
- `entities/hosts.ts` — `HostRule.vendor`, `sub()` matcher, `MULTI_SERVICE_APEXES`. Removed blanket `amazonaws.com`/`googleapis.com` rules (they collapsed every service into one row).
- `entities/index.ts` — `resolveHost()`: explicit rules first (they carry `provider`, which pricing needs), then subdomain-derived service for multi-service apexes, then registrable domain. **Service names are DERIVED, not hardcoded** — `s3`, `kinesis`, `athena` all work with no table entry. Overrides exist only for LLM hosts (Bedrock, Vertex) where `provider` drives pricing.
- `query/index.ts` — `usageRows()` (groups by method AND endpoint; `pricedCalls` so unpriced ≠ $0.00) and `usageTree()` (vendor>service>host>endpoint, rollups, single-child collapse).
- Tests: `tests/vendors.test.ts`, `tests/usage.test.ts`. 113 core + 42 cli green.

**Next:** CLI Usage screen consuming `usageTree` (replaces Entities tab). Then Logs tab, project scoping, traces.

**Wireframes:** https://claude.ai/code/artifact/b82fe773-1b33-46f1-a3da-bd852576c758 · **Interactive prototype:** https://claude.ai/code/artifact/a60f8202-fb9b-45c8-bd70-1698019871bc

**Still uncommitted** — whole tree is untracked in git.

---
## 2026-07-26 — v1 build: five slices, 155 → 329 tests

`pnpm -r test` **329 green** (241 core + 88 cli) · `pnpm -r build` clean · `pnpm -r lint` clean.
All five planned slices landed. §5/§6 (API pricing, cost engine) untouched, as instructed.
User chose **not** to commit — tree is still working-tree-only.

### What shipped

**1. Usage screen** (`screens/Usage.tsx`) — consumes `usageTree`. Depth 0 expanded by
default, deeper collapsed, `h`/`l`/`⏎` toggle, cursor-following scroll, nothing truncated.
LLM rows meter in tokens, everything else in bytes.
Byte honesty fixed in the same slice: `reqBytes`/`resBytes` are `number | null`, the undici
DC path emits `null`, `fetch-patch` uses `Buffer.byteLength`. Old `Entities` screen and its
`entityDetail` query deleted.

**2. Logs tab** (`screens/Logs.tsx`) — `traces()` gained `llm: true|false|null` plus
`entity`/`errorsOnly`, and `traces`+`liveTail` now share one `filterSql` builder. Follow
mode polls `liveTail`; ↑/↓ pauses; `f` resumes; `/` cycles all·llm·api·errors; scrollback
pages 50 older rows via `beforeId`.

**3. Project scoping** — schema **v2**: `projects.key` (path- or name-derived, never the
display name), `requests.service`. `Scope {projectIds, services}` threaded through every
read. `--all` / `--project` / `--service` are global flags; `burn0 projects` lists them.
Retention moved off the read path onto capture init and takes a `projectId`. Config gained
`dbPath` (env → file → default, relative resolved against the config file) and `service`.
TUI header shows the scope; `p`/`s` cycle it, and neither key exists when there is nothing
to cycle.

**4. Traces** — schema **v3**: `runs`, `traces`, `requests.run_id/trace_id/seq`, `tool_io`.
Four-class server patch, `withTrace`, stale sweep, `traceList`/`traceTree`, LLM trace list
with STEPS shape column, two-pane `TraceView`.

**5. Tool calls (§8)** — `llm/tools.ts` (OpenAI + Anthropic + SSE deltas), tool traces with
`tool_status`/`attribution`/`tool_io`, half-open window attribution in `traceTree`, 🔧
rendering with error/unresolved marking.

**Also fixed** (all on the trap list, all previously mis-billing): pricing lookup order is
provider-qualified first (Gemini was 1.5× over), `$0/$0` entries return `null`, the
`&& provider` gate in `enrich.ts` is gone, and `fmtUsd` renders `<$0.0001` instead of
`$0.0000` for a real-but-tiny cost.

### Traps found during the build — do not rediscover

- **`http2.Http2Server` and `Http2SecureServer` are NOT exported from `node:http2`** (22.12).
  Reach them via `Object.getPrototypeOf(http2.createServer()).constructor`. All four server
  prototypes are distinct; every inheritance check comes back false. `'request'` *does* fire
  through `Http2Server.prototype.emit`.
- **`seq` was `[0, 2, 4]`.** Three capture paths observe one call; dedup rejects duplicates
  at *emit* time, but `takeTraceStep()` ran at *observe* time, so deduped calls burned a
  sequence number. Take the step only after every bail-out. Unit tests cannot see this — it
  took a real server making real calls (`tests/trace-e2e.test.ts`).
- **`ON DELETE CASCADE` does not fire.** better-sqlite3 leaves `PRAGMA foreign_keys` off.
  Retention deletes traces/`tool_io`/runs explicitly, children before parents.
- **The §8.4 window must be half-open.** Inclusive at both ends puts the result-carrying
  request inside its own window, so every resolved tool looked like it called the LLM back.
- **CLI tests resolved `@burn0/core` to `dist`.** A core change was invisible until someone
  rebuilt, and the suite reported green against stale output — it produced one wrong
  diagnosis before it was spotted. `packages/cli/vitest.config.ts` now aliases to `../core/src`.
- **Arrow-key constants in TUI tests need a literal ESC byte.** Write the escape
  explicitly as a `\u001B` escape followed by `[B`; a bare `[B` is delivered as two
  printable characters and `key.downArrow` never fires. The older tests hold a raw 0x1b
  byte in the source, which is invisible when reading the file — that is how this got
  copied wrong in the first place.
- **Two-pane layout needs `<Box width={columns}>` on the container**, or the detail pane is
  laid out against a different width than its sibling was sized for and wraps to one char
  per line.
- **`expect`-driven pty still cannot send keys to Ink** (arrows *and* tab). Initial render
  verifies fine; navigation must be verified with `ink-testing-library`.

### Demo

`pnpm --filter burn0-test demo` and the new `pnpm --filter burn0-test agent`
(`src/agent-server.mjs`) — an instrumented server whose routes produce the plain trace shape,
an agent turn with a tool call, and explicit `withTrace` nesting. **Mock vendors now run in a
separate process** (`src/vendors.mjs` + `src/start-vendors.mjs`): in-process mocks are real
inbound requests, so burn0 correctly auto-rooted a trace for each one and the demo appeared
to have 3× its traffic. All five tabs rendered against the resulting database; the §8 tool
tree is reproduced verbatim in spec §8.

### Next

- §12.1a `g` grouping (time → route → model) — deferred, not started.
- §5/§6 API pricing + cost engine — still deferred by the user.
- Q8.6 (new): tool nodes hang off the enclosing trace, not off the declaring LLM call's own
  span, because an LLM call is a `requests` row and has no span. Prerequisite for nested agents.
- Q1.1 (`burn0 projects rm`) still open.
- `--project`/`--service` are parsed and scoped but have no TUI equivalent beyond `p`/`s`.

---

## 2026-08-04 — Bun + Hono support (spec §13)

Bun 1.3.x is now a first-class capture runtime. `bun --import burn0/register src/index.ts`
(also `--preload`; composes with `--watch`/`--hot`) gives the same zero-instrumentation
capture as Node: auto-rooted trace per inbound request, outbound LLM/API calls under it in
`seq` order, one SQLite file the Node CLI reads unchanged.

**Design in one line:** runtime **capability table** (`src/runtime.ts`) → init wires patches
from capabilities, never runtime names. Bun gets `fetch-patch` (unchanged) +
`bun-serve-patch`; Node path untouched. Storage picks `bun:sqlite` vs better-sqlite3 at
`openDriver()`.

**Verified end to end:** Hono agent route on `Bun.serve` under `--watch`,
`NODE_ENV=production BURN0_FORCE=1`, one `POST /api/conversations/48213/chat` → the §2.6/§8
tree (declare-tool gpt-4o 640→28 · 🔧 search_orders `window`-attributed holding /query +
/v1/charges · final gpt-4o 1204→380, costs computed) — rendered by **Node** `burn0 today`
and `query.traceTree` from the Bun-written DB. Suites: 17 bun:test green
(`pnpm --filter @burn0/core test:bun`), Node regression core 241 + cli 88 green.

### Traps found — do not rediscover

- **Bun auto-serves `export default app` through the patchable JS `Bun.serve` property**
  (measured 1.3.9). This is the fact the whole design stands on — no Hono adapter, no
  route integration, one property wrap covers every serve shape. Wrap `options.fetch`,
  `options.routes` (incl. per-method maps), and `server.reload`.
- **better-sqlite3 under Bun is undefined behavior, not a clean fail.** Script mode:
  require refused ("not yet supported", oven-sh/bun#4290). `bun test` mode: require
  *succeeds*, then the process **hangs on first use** of the addon. Consequence: both
  sqlite bindings load via lazy `createRequire` inside `openDriver` — a top-level import
  dies before init's try/catch exists. Do not assert on the exact failure mode in tests;
  it differs by entry mode.
- **In-process mock vendors must start *before* `initBurn0` in bun tests** — same trap as
  the Node demo (vendors got auto-rooted traces), solved by ordering instead of a second
  process: patches only wrap servers created after init.
- **vitest's default glob eats `tests/bun/`** — bun:test files import `bun:sqlite` and Bun
  globals, so core now has a `vitest.config.ts` excluding them. Symmetric risk: `bun test`
  run from the package root would try the vitest files; scripts pin `bun test tests/bun`.
- ALS propagation through `Bun.serve` handler → outbound fetch → teed SSE body: works,
  verified with a real Hono router before any code was written.

### Limitations (documented in spec §13.3 / README)

fetch-only outbound capture; no auto-roots for Bun's `node:http` compat servers
(`Bun.serve` is the primitive); post-return `ReadableStream` work may fall outside the
trace; WS upgrades close with status NULL; tested on 1.3.9 only.

---

## 2026-08-05 — TraceView redesign + honest token semantics (spec §1.2, §2.6, §8, §12.1b)

**Shipped:** the trace view is rewritten wholesale on top of a pure `tree-model.ts` row
builder — a real LangGraph trace that used to render as a 32-row flat wall of truncated
SAP URLs now renders as a tree with fold rows, turn ordinals, and per-row token/cost
columns that agree with the aggregate. Token semantics changed underneath every screen
that shows a number: `tokens_in` is now total effective input (fresh + cache-read +
cache-write) for every provider, `↺` marks known cache-read, a `written` line appears in
the detail pane wherever cache-write happened, and `computeCost` prices all three tiers
instead of silently zeroing Anthropic's fresh-input cost against a large cache. Detail
pane rewritten as five chat-style cards (LLM/tool/API/root/fold) with degraded-state
wording for expired payloads, redaction, and unparseable bodies. Full state contract:
live root (`● LIVE`, elapsed TOOK), incomplete (force-closed, `⚠`), pruned mid-view,
status-NULL split (request=known-failure-red vs root=known-unknown-dim), parallel-tool
attribution (`~turn`), flat mode, single-pane fallback below 110 columns. Full design:
`docs/superpowers/specs/2026-08-04-traceview-redesign-design.md`. Spec `docs/spec/2026-07-25-burn0-v1-spec.md`
§3.6/§8.7/§12.1b updated; schema is now v4.

**Normalization decision: parse-time, not display-time — and why parse-time won.**
Providers disagree about what "input tokens" means (OpenAI/Gemini report the total with
cache as a subset; Anthropic reports uncached-only, with cache-read and cache-write
additive on top, billed at different rates). The alternative — leave storage alone and
reconcile per-provider at every display site — was rejected because burn0 has *five*
token-displaying screens (TraceList, Logs, Usage, TraceView tree, detail pane) plus
`computeCost`, and provider-branching logic duplicated six times drifts the moment one
site is updated and another isn't; it also can't fix `SUM(tokens_in)` across a trace with
mixed providers, which is exactly the discovery-incident case. Normalizing once in
`enrich()` via `normalizeUsage()` — before the row is written — means every consumer,
present and future, reads one honest number with no provider knowledge required. The one
trap: normalization must run exactly once. Putting it inside the per-format parsers
(JSON vs SSE) would double-add cache tokens for payloads that hit both code paths in the
same request lifecycle; it runs in `enrich()`, downstream of both parsers, instead.
Provenance (`inputIncludesCache`) is decided by **which key supplied the number**
(`prompt_tokens`/`promptTokenCount` vs `input_tokens`), not by hostname — a gateway that
reshapes a provider's payload is classified by payload shape, which is the only thing
that's actually true of it.

**Fold rules (run-folds, the discovery-wall fix).** ≥4 consecutive sibling *leaf* API
requests collapse by default into one row (`▸ 12× GET sap.com  …/opu/odata/sap/*`) when
they share the same entity, the same HTTP verb, and every member has status < 400. Any
error or null-status row breaks the run — a fold must never swallow a failure, so a
fold row is always a true statement ("12 succeeded"), never a lossy one. `l`/`⏎` expands
losslessly in place; fold identity is keyed on the *first* member's request id so an open
fold survives live appends to the trace. Threshold 4 is a named constant, not config —
below 4, the discovery wall doesn't yet exist and folding would hide more than it saves.

### Traps found during implementation — do not rediscover

- **Fold-state-from-depths bug.** The tree-pane's "is this branch open" check compared a
  row's depth to its next row's depth (`+1` = open, correct for tool/trace branches whose
  children really do sit one level deeper). Fold rows broke it silently: a fold's members
  are the *same* leaf nodes at the *same* `node.depth` they'd have unfolded — tree-model
  only deepens their guide-prefix rendering, never the depth field — so an open fold
  always looked closed to this check. `⏎` could open a fold once but never close it again.
  Fix: a dedicated `isBranchOpen()` dispatches on row kind — folds check the
  `expanded`/`collapsed` sets directly; everything else keeps the depth check. Any future
  "is this row expanded" logic must go through `isBranchOpen`, not re-derive depth deltas.
- **Live-follow precedence, inverted.** The cursor-resolution effect tried identity lookup
  (`rows.findIndex(cursorKey)`) first and only fell back to "was I on the last row → follow
  the new last row" when identity lookup failed. But the whole point of the live-append
  case is that the cursored row usually does *not* disappear — it just stops being last —
  so identity succeeding permanently defeated follow for exactly the scenario follow
  exists for. Fixed by checking was-last-row first, unconditionally, with identity as the
  fallback. Order-of-checks bugs in "resolve selection after a list changed" logic are
  invisible in isolation; only a live-append test with a *surviving* cursor key catches
  this class.
- **Strip measured-fit, not threshold guesses.** The detail-pane strip line (status ·
  duration · cost · tokens · optional first-byte/start-time) was first built on hardcoded
  width thresholds (drop first-byte below 44 cols, start-time below 36) inferred from the
  spec prose. Real content varies (a 4-digit vs 6-digit cost) enough that a fixed
  threshold both over-drops at some widths and overflows at others. Rewritten to measure
  the actually-composed line and shed segments while it doesn't fit, only ever dropping
  first-byte then start-time, never a mandatory segment (which wraps onto a second line
  instead of being cut). Any fixed-column-count budget for a variable-content line is a
  bug waiting for the input that breaks the guess.
- **`capLines(n, 1)` needs its own rule.** A cap of exactly one line must keep the one
  real line of content and drop the `+N more` marker entirely — "+6 more" with no visible
  text above it is worse than one truncated-but-real line. Generalizing the "keep N lines,
  append +M more" cap without a floor case for N=1 produces a card that is pure metadata.
- **`truncLeft` boundary-slash ruling.** Left-truncation snaps forward to the next `/`
  only when that slash sits within the first 4 characters of the kept tail — and a slash
  sitting at index 0 (already on the boundary) is a no-op, not a "delete this char and
  snap" case. The original `slice(slashIndex || 1)` treated index-0 as falsy and defaulted
  to slicing at 1, silently eating the boundary slash on every truncated endpoint
  (`…sap/API_…` instead of `…/sap/API_…` — the tail looks like it lost its head). `0` and
  "not found" are different values; never coalesce them with `||`.
- **better-sqlite3 is ABI-locked to the Node version it was built against.** The gate must
  run under the same Node the package was installed/rebuilt for — this repo pins
  **nvm node v22.12.0**. Running core's test suite under a different Node on `PATH`
  (or with a shell that doesn't source nvm) throws a native-module ABI mismatch, not a
  helpful "wrong Node version" message. `$HOME/.local/bin` must also be on `PATH` and
  bun resolved at `~/.bun/bin/bun` for the `test:bun` half of the gate — three separate
  runtimes (node via nvm, system PATH tools, bun) all need to be reachable in the same
  shell before `pnpm -r test` / `pnpm --filter @burn0/core test:bun` will both go green.

### What remains

- `theme.selBg` — deferred; Ink has no terminal-capability detection, so selection stays
  `<Text inverse>` rather than a themed background.
- ASCII glyph fallback (no-Unicode terminals) — recorded as a follow-up, one-file change
  by construction, not built.
- `fmtMs`'s `m ss` form — explicitly rejected for this redesign (elapsed/duration stay in
  seconds-with-decimal or the new `fmtElapsed` "still counting" form; no minutes anywhere).
- §5/§6 (API pricing + cost engine) — still untouched, unchanged since the 2026-07-26
  entry above. Still deferred by the user ("cost later").
- Full list of smaller deferred items and judgment calls (fold-member `⏎` behavior,
  `FOOTERS[2]` fallback status, `requestDetail` not selecting `tokens_cache_write`, the
  24-row-terminal detail-card truncation point, and others) lives in each task's own
  report under `.superpowers/sdd/2026-08-04-traceview-redesign/task-*-report.md` — not
  re-copied here.

**Gate, final run:** `pnpm -r test` → core 27 files/278 tests, cli 21 files/234 tests, all
green (512 total). `pnpm --filter @burn0/core test:bun` → 3 files/20 tests/83 expect()
calls, all green. `tsc --noEmit` clean in both `@burn0/core` and `@burn0/cli`.

### Next

- Q13.1 `patchHttp` under Bun (axios-on-Bun) once compat internals verified.
- Q13.3 defer Bun trace close to body completion for streaming Responses?
- Unchanged from previous entry: §12.1a `g` grouping, §5/§6 API pricing, Q8.6, Q1.1.

### Addendum, same day — streaming agent loops broke the first cut (fixed)

First real backend (LangGraph on Bun/Hono) surfaced it within hours: a streaming chat
route returns its SSE Response in ~ms, then runs the agent loop *inside* the response
stream for tens of seconds. Close-at-handler-resolve (what the task spec literally asked
for) orphaned every LLM call made after the return — each rendered as an individual
untraced model-labeled row instead of nesting under `POST /chat`.

Two fixes, both tested:

- **`bun-serve-patch` now matches Node's close semantics** (close after last byte, not
  after handler). Unsized `ReadableStream` bodies are replaced with a manual reader-pump
  that closes the trace on completion *or client cancel* — pump, not
  `pipeThrough(TransformStream)`, because TransformStream has no cancel hook and
  disconnect is exactly the case that must still close (Node's 'close'-beside-'finish'
  lesson, again). Fixed-length bodies (`Bun.file` sendfile path) and bodiless responses
  still close at resolution. Stale sweep unchanged as backstop.
- **Writer race, runtime-independent:** a row can land one flush after its trace's close,
  when `localToDb` had already dropped the mapping → trace_id NULL. `createWriter` now
  keeps closed mappings for one extra flush cycle (`deleteNextFlush`).

Regression tests: `tests/bun/serve-trace.test.ts` — agent-loop-in-stream (2 LLM calls
40ms+ after handler return share one trace, seq 0/1, trace spans the stream) and
client-disconnect-mid-SSE (trace closes via cancel, not leaked). 19 bun + 241/88 node
green. Spec Q13.3 resolved; §13.2/§13.3 + README updated. Dist rebuilt — restart any
preloaded app to pick it up.
