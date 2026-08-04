# TraceView redesign + honest token semantics — design

**Date:** 2026-08-04
**Status:** validated (4-lens design workshop + adversarial critique, synthesized; user approved the synthesis)
**Relationship:** implements the LangSmith-parity direction for spec §2.6/§8/§12.1b; supersedes the current `TraceView.tsx` rendering wholesale. Token semantics changes touch core (§3/§8 adjacent) and every token-displaying screen.
**Prerequisite already decided elsewhere:** Anthropic SSE tool-call extraction (`content_block_start`/`input_json_delta`/`content_block_stop`) lands in `llm/tools.ts:fromSSE` — without it the target user's traces have no 🔧 nodes and no tree structure.

Driving incident: a real LangGraph-on-Bun backend rendered as a 32-row flat wall of
truncated SAP OData URLs, and its token column read `2 → 3432` against ~46.8k cached
input tokens. The user rejected both, against LangSmith's trace view as the reference.

---

## 1. Token semantics — normalize at parse time (schema v4)

### 1.1 The defect

Providers disagree about what "input tokens" means:

| Provider | reported input | cache read | cache write |
|---|---|---|---|
| OpenAI | `prompt_tokens` = **total** (cached is a subset via `prompt_tokens_details.cached_tokens`) | subset | not reported |
| Anthropic | `input_tokens` = **uncached only** | `cache_read_input_tokens`, additive | `cache_creation_input_tokens`, additive, billed 1.25×/2× |
| Gemini | `promptTokenCount` = **total** (`cachedContentTokenCount` subset) | subset | not reported |

burn0 stores whatever arrived, so `SUM(tokens_in)` mixes incomparable quantities, the
display shows `2 → 3432`, and — worse — `computeCost` subtracts cached from input
(subset semantics), which for Anthropic computes `max(0, 2 − 46 800) = 0` and **silently
drops the fresh-input cost**. Cache-write tokens are not captured and never priced.

### 1.2 The fix (all in one commit; schema v4, pre-release `.bak` reset applies)

- **`tokens_in` = total effective input** (fresh + cache-read + cache-write) for every
  provider. Normalized once, in `enrich()`, by `normalizeUsage()` — never inside the
  per-format parsers (prevents double-adding across JSON/SSE branches).
- `Usage` gains `tokensCacheWrite` and `inputIncludesCache: boolean`. The flag is
  decided by **which key supplied the number** (`prompt_tokens`/`promptTokenCount` →
  true; `input_tokens` → false) — gateways classify by payload shape, not hostname.
  `parseSSEUsage` additionally reads `cache_creation_input_tokens` from `message_start`.
- Schema: `requests.tokens_cached` keeps its meaning (cache-READ subset, null = not
  reported); **new column `requests.tokens_cache_write`** (null = not reported).
  Invariant: `tokens_in − tokens_cached − tokens_cache_write ≥ 0` = fresh tokens.
- **`computeCost`**: `PriceEntry` gains `cache_creation_input_token_cost?` (LiteLLM
  carries it). `cost = fresh·input + read·(cache_read ?? input) + write·(cache_write ??
  input) + out·output`. The `?? input` fallbacks are deliberate: pricing at the base
  rate under-labels; inventing a multiplier fabricates. `$0/$0 → null` rule untouched.
- Unknown-provider heuristic (display never needs it — stored data is normalized):
  none. Delete any display-time provider branching.

### 1.3 Formatter (`format.ts`) — one vocabulary, every screen

- `CACHE_MARK = '↺'` (U+21BA; measured width 1 under Ink's string-width). Presence-only:
  shown iff known cache-read > 0. Never a number — rollups that can't distinguish
  "0 cached" from "not reported" must never imply either. Cache **writes** get no glyph;
  they are a labelled detail-pane line only.
- `fmtTok(n)`: `—` null · exact < 1 000 · one decimal 1 000–99 999 (`4.0k`, `46.8k`) ·
  integer 100k–999k · same tiers at `M` and `B` · re-bucket at boundaries (999 950 →
  `1.0M`, never `1000k`). Lowercase `k` (spec §12.1a precedent).
- `fmtTokPair(in, cached, out)`: `{fmtTok(in)}{cached>0 ? '↺' : ''}→{fmtTok(out)}`,
  spaced variant for the TraceList column. **Each side independently null-checked** —
  `—→846` is legal and required; both null → `—` (governed by `tokenCalls` known-counts).
  Worst cell `99.9k↺→99.9k` = 12 chars (measured).
- Surfaces: TraceList "Tokens in→out" w15 spaced · TraceView tree TOKENS w12 unspaced ·
  Logs volume w11 unspaced (bytes path unchanged) · Usage In/Out w11 (`46.8k↺` / `846`) ·
  detail pane exact `fmtNum` block (below).

Detail-pane token block (lines omitted when null, shown when known 0 — the null-vs-0
rule made visible; percent only when total known):

```
tokens    46,802 → 846
  fresh   2
  cached  46,800 ↺ (99%)
  written 1,024
```

Payload screen adopts the same fresh/cached/written wording.

- **Partial-usage cost**: when a costed row has `tokensIn == null XOR tokensOut ==
  null`, detail pane renders `~$X · partial usage — true cost is at least this`,
  derived at read time. The capture-side `estimated` flag is NOT repurposed. Columns
  show the plain figure.

## 2. Tree pane

### 2.1 Row grammar

STEP cell = `{guides}{marker} {name}{suffix}` composed to exactly the column width
**before** `TableRow` (`fit()` becomes a no-op safety; it must never slice — `🔧` is a
surrogate pair). Guides: `├ └ │  ` two chars per depth. **Suffix reservation:** suffixes
(`400`, `error`, `unresolved`, `~`, `#n`, `▸N`, `incomplete`) are computed first; the
name absorbs all truncation. A truncated endpoint is an inconvenience; a truncated
`error` is a lie of omission.

| Row | marker | name | suffixes (order) | COST | TOKENS | TOOK |
|---|---|---|---|---|---|---|
| trace root | — | route, bold accent | mix `· 7◆ 7🔧 25◇` (droppable) · status ≥400/null · `⚠ incomplete` | Σ subtree | Σ normalized | wall span |
| LLM req | `◆` magenta | model verbatim | ` #n` dim turn ordinal · status ≥400/null | fmtUsd/`—` | `46.9k↺→412` | own |
| tool | `🔧` cyan | tool name | ` ~` window / ` ~turn` (dim) · ` error`(err)/` unresolved`(warn) · ` ▸N` collapsed | LLM-desc Σ else `—` | LLM-desc Σ else blank | window |
| API req | `◇` dim | `{entity} {VERB unless GET} {tail}` | status ≥400/null | `pricedCalls>0` rule (no hardcode) | blank | own |
| withTrace | — | name, bold accent | ` ▸N` collapsed | Σ | Σ | span |
| run-fold | `▸`/`▾` | `{n}× {VERB} {entity}  {common-tail}*` | — | `—` | blank | first→last span |

Blank vs `—` in TOKENS is deliberate: blank = not a concept for this row; `—` =
applicable but unreported. Turn ordinals `#1…#n` = 1-based index over LLM requests in
seq order — the anchor that makes seven identical model names scannable and shows
context growth across the loop.

### 2.2 Left-truncation (exact)

Budget `b` = STEP − guides − marker − entity − spaces − reserved suffixes. If path fits,
render whole; else `…` + `path.slice(len−(b−1))`, then snap forward to a `/` only if one
occurs at index ≤ 4 of the kept tail. Query strings never appear in the tree
(`normalized_endpoint` only). `…` is always 1 char, always leftmost. Root name is the
only right-truncated name (route signal is at the front).

### 2.3 Run-folds (the discovery-wall fix)

≥4 **consecutive sibling leaf** API requests with same entity + same verb + all
status < 400 collapse by default into `▸ 12× GET sap.com  …/opu/odata/sap/*` (count,
span, `—` cost). `l`/`⏎` expands losslessly in place. **Any error or null-status row
breaks the run** — a fold must never swallow a failure. Fold identity in the expansion
set keys on the first child's request id (stable across live appends). §4.2b-clean: the
row states exactly what it aggregates. Threshold 4 is a named constant, not config.

### 2.4 Color discipline

Red = failure only (status ≥400, network-failure rows, tool `error`). Durations render
dim; ≥15% of root duration → normal; ≥40% → warn. Root TOOK normal. Denominator falls
back to max node duration while the root is open. `latencyColor` is not used anywhere in
this screen (its absolute thresholds paint every normal agent-loop LLM row red).
Selection stays `<Text inverse>` (`theme.selBg` deferred — no capability detection in Ink).

### 2.5 Columns & widths

`STEP grow (min 29) · COST 8 · TOKENS 12 · TOOK 7`, gaps 2. Pane =
`min(floor(0.62 × columns), 98)` (cap hands surplus to prose in the detail pane).
Verified: 110 cols → pane 68, STEP 35; 140 → pane 86, STEP 53; 200 → pane 98, STEP 65.
Single-pane (<110): same grammar, STEP = columns − 34.

### 2.6 Reference mockup (140 cols; `↺` on every cached LLM row; fold row 2)

```
STEP                                                      COST       TOKENS      TOOK
POST /api/conversations/:id/chat · 7◆ 7🔧 25◇          $0.1448   342k↺→2.8k    48.3s
├ ▸ 12× GET sap.com  …/opu/odata/sap/*                       —                  2.1s
├ ◆ claude-sonnet-5 #1                                 $0.0203   46.9k↺→412     5.6s
├ 🔧 sap_execute_sap_operation ~                             —                  1.4s
│ ├ ◇ sap.com  …/sap/API_SALES_ORDER_SRV/A_SalesOrder        —                620ms
│ └ ◇ sap.com  …PI_SALES_ORDER_SRV/A_SalesOrder/$count       —                180ms
├ ◆ claude-sonnet-5 #3                                 $0.0242   48.1k↺→655     8.4s
├ 🔧 sap_execute_sap_operation ~ error                       —                  1.8s
│ ├ ◇ sap.com  POST …_SALES_ORDER_SRV/A_SalesOrder 400       —                460ms
└ 🔧 sap_execute_sap_operation ~ unresolved                  —                  3.1s
```

Rejected for the tree (recorded): proportional duration bars (36-char STEP starves
names; overlapping tool windows make bars that don't sum — a quiet lie; revisit as a
detail-pane waterfall); `▸/▾` gutter on every branch (2 cols × every row; branch-ness is
already encoded by row type — `▸/▾` exists only on fold rows, ` ▸N` suffix only when
collapsed); uppercase `K`; `⚠`/`✗` glyphs for tool failure (ambiguous-width; words).

## 3. Detail pane (right, `columns − pane − 2`, stated width not flexGrow)

Non-scrolling preview; `⏎` opens the payload screen (which scrolls). Border box,
title = first line inside (Ink borders take no titles). Height budget
`B = max(12, rows−12)`; content `C = B − 5`. Stats strips never drop status, duration,
cost, tokens; below 44 inner cols drop `first byte`, then start time; attribution moves
to its own line; host/bytes split lines.

- **LLM row:** strip (status · duration · first byte · start; cost · token block §1.3;
  duration uncolored — red is failure only). Then: `… N earlier messages · system 1.4K
  chars` → last real USER text → `TOOL RESULT ✓/✗ name · 18.3 KB` lines (cap 3; name by
  `tool_use_id` match against the previous assistant message, `—` if unmatched — never
  positional guessing) → ASSISTANT text (cap 8) → `→ tool_name({args…})` cyan lines
  (cap 4 + `+N more`). **Tool-call-only responses render their calls — the §8.1
  empty-panel bug dies here.** SSE always extracted, raw `data:` lines never shown.
  Deterministic shrink order: assistant→4, user→2, drop system, results→1, tools→2,
  drop marker, assistant→2, user→1.
- **Tool row:** strip (`ok/error/unresolved/running` · duration · time; attribution
  sentence: `exact (withTrace)` / `window (inferred)` / `turn — parallel tools; calls
  shown at turn level`; rollup `beneath it: N calls · $X`). ARGS pretty-printed ≤16 KB
  (cap 6 lines), RESULT raw (cap 6). `unresolved` → `result never returned to the model
  — window closed at trace end`. `tool_io` pruned → `args & result expired (payload
  retention: 7 days)` + `structure and status remain for 30 days`.
- **API row:** full METHOD + endpoint (wrap, cap 3) + decoded query string (cap 2,
  **secret-pattern redaction applied — `redactBody` never ran on URLs**), strip, host +
  `out/in` bytes (`fmtBytes`, null → `—`), RESPONSE head 3 lines (6 + red label when
  status ≥400; `no response — network failure` when status null), `called from
  {stackSnippet}` dim, `⏎ full payload`.
- **Root row:** strip + STEPS shape line (cap 24 + `+N`) · `$X · N of M calls priced` ·
  token block (normalized sums make this well-defined) · composition (`4 LLM
  (claude-sonnet-5) · 2 tools · 5 API (2 services)`) · `slowest` / `costliest` rows ·
  `issues` line (status ≥400 count, failures, tool errors/unresolved, incomplete) —
  omitted entirely when clean.
- **Fold row:** `N× VERB entity`, common prefix, span, min/median/max duration,
  `all 2xx/3xx`, `⏎/l expands`.
- Degraded states: payload expired vs `capturePayloads: false` distinguished by row age
  vs reader retention; redacted bodies rendered as stored; unparseable → summary card +
  2 raw lines, never blank; "no text and no tool calls in response" stated when true.
- Perf: memoize extraction by `(requestId, payload != null)`; 16 KB pretty-print gate.
  Both load-bearing at the 1 s poll.

## 4. States contract (30 states — the professional layer)

Global mechanics: **cursor keyed to node identity** (`"type:id"`), not index — the
selected row must never slide under the 1 s poll; **expansion = persistent Set** of
node keys, default expanded at depth ≤ 2, folds collapsed regardless, root
non-collapsible (`h`/`⏎` no-op); **live-follow positional** — cursor on last row
follows appends, anywhere else stays (Logs' ↑-pauses rule transposed); **footer via
`useFooter(text)` context** — the static `FOOTERS` table lies mid-drill today;
**payload screen is a child state of TraceView** — esc returns to the tree, state
intact; **`traceTree` returns `{root, nodes} | null`** — the current
`nodes.length === 0` check prints "calls expired" for a *pruned* trace, exactly
backwards.

Highlights (full table in the workshop archive; these are binding):

- **Live root:** `● LIVE` suffix, TOOK = `14s…` elapsed dim; aggregates render normally
  (facts so far). Zero calls yet → `waiting for first call…`, never the expired message.
- **Incomplete (force-closed):** `⚠ incomplete` warn; TOOK `—` — the sweep's
  observation window is not a duration; detail labels it `open for 11m 4s (observation,
  not duration)`.
- **Expiry:** new `traces.expired_calls` column, incremented by the retention sweep —
  the only actor that ever knows N. Full expiry → `· 14 calls expired (older than 30d)`
  info row; partial → info row first (oldest rows die first) and root cost carries
  `(excludes 9 expired calls)` — a partial sum without the caveat is a wrong number
  presented as fact. Pre-column cohort reads 0 for ≤30 days; accepted, noted.
- **Pruned mid-view:** whole pane → `Trace no longer in the database — pruned by
  retention while you were viewing it.` No auto-navigation.
- **Status NULL split:** request → red, `network failure (no response received)` —
  a known failure. Trace root → dim `—`, `not observed (handler threw, or the
  connection upgraded)` — a known unknown. One color per epistemic state.
- **Parallel tools (`turn`):** ` ~turn` suffix + detail sentence only (no per-request
  `·` marks — no user evidence yet). Window-attributed: dim ` ~` suffix (resolves Q8.2:
  one dim char on the common path; certainty never implied).
- **withTrace inside a tool body:** renders as the tool's *sibling* (ALS parent is the
  enclosing trace) — inference never overwrites explicit structure.
- **Depth:** indent caps at 6 levels; §2.4's semantic cap needs no extra UI.
- **Flat mode `f`:** request rows only, seq order; expiry info rows retained (hiding a
  data-loss notice in either mode is hiding data).
- **Resize across 110:** state survives; layouts swap statelessly. Tab switch resets
  drill (Q12.1 reasoning). Scope keys don't evict an open trace.
- **Untraced list rows:** ⏎ → payload screen directly; list footer says `⏎ open`.
- **Single-pane ⏎:** LLM/API leaf → payload screen directly (whose LLM section is
  rewritten chat-style via shared `extractExchange`). No chat overlay layer, no tool
  I/O screen (⏎ on tools = branch toggle, both layouts; tool ARGS/RESULT are
  detail-pane-only in v1 — a stated narrow-terminal limitation, not a new screen).

Keybinds: `↑↓` move · `h` collapse/jump-to-parent · `l` expand · `⏎` branch-toggle /
leaf-payload / info-row-no-op · `f` flat⇄tree · `esc` unwind one level · footers list
every live key.

## 5. Consolidated data-layer changes (complete; no other core changes)

1. `llm/parse.ts`: `Usage.tokensCacheWrite`, `Usage.inputIncludesCache`;
   `parseSSEUsage` reads `cache_creation_input_tokens`.
2. `capture/enrich.ts`: `normalizeUsage()` applied once; writes normalized
   `tokensIn` + `tokensCacheWrite`.
3. `storage/schema.ts`: v4 — `requests.tokens_cache_write`,
   `traces.expired_calls INTEGER NOT NULL DEFAULT 0`.
4. `storage/retention.ts`: sweep counts request rows per trace before deleting;
   increments `expired_calls`.
5. `pricing/index.ts`: `cache_creation_input_token_cost`; `computeCost` per §1.2.
6. `query/index.ts`: `traceTree` → `{root, nodes} | null`; `TraceTreeNode` gains
   `endedAt`, `tokensCached`, `tokensCacheWrite`, `tokenCalls`, `reqBytes`, `resBytes`,
   `expiredCalls`; `durationMs` forced null when `incomplete`. New
   `query.toolIo(db, traceId)` → `{args, result, truncated} | null` (written today,
   never read). `requestDetail` selects `req_bytes, res_bytes`.
7. `format.ts` (cli): `fmtTok`, `fmtTokPair`, `CACHE_MARK`; glyph constants module with
   the pre-fit composition rule (never let `fit()` slice a surrogate pair).
8. `llm-io.ts` (cli): rewritten as `extractExchange(reqBody, resBody)`; imports
   `parseToolCalls`/`parseToolResults` from core (exported); used by both the detail
   pane and the payload screen.

## 6. Testing

- Core: `normalizeUsage` per provider × JSON/SSE (incl. gateway-shaped payloads);
  `computeCost` cache-write pricing + Anthropic fresh-input regression (`2 + 46 800`
  case must not price as 0); `expired_calls` sweep counting; `traceTree` null vs root
  contract; `toolIo`.
- CLI: `fmtTok`/`fmtTokPair` tier + boundary + null-side table; truncation algorithm
  property tests (suffix survival at any width, `…` leftmost, surrogate safety);
  ink-testing-library renders — reference trace, fold expand/collapse, live append
  cursor stability, every B-state with a distinct rendering asserted by its exact
  wording; footer per state.
- E2E (bun + node): agent-loop fixture → tree with folds + turn ordinals + `↺`;
  cross-runtime DB read unchanged.

## 7. Out of scope (recorded rejections)

Waterfall bars in the tree · chat overlay layer · tool I/O screen · `theme.selBg` ·
per-request parallel-turn marks · depth badges beyond indent cap · ASCII glyph
fallback config (follow-up; one-file change by construction) · `fmtMs` `m ss` form ·
count-based auto-collapse (folds are presentational aggregation, not depth collapse).

## 8. Implementation sequencing (binding)

Milestone 1 is a **visual checkpoint**: token normalization + tree renderer only,
rendered against the user's real `alif-backend` trace, screenshotted for sign-off
before the detail pane and states land. The felt aesthetic is the one thing this spec
cannot prove; it gets validated first, cheaply.
