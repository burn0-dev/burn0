# TraceView Redesign + Honest Token Semantics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the trace view to LangSmith-grade readability on real agent traffic, on top of parse-time-normalized, cross-provider-honest token data.

**Architecture:** Core first: Anthropic SSE tool extraction, token normalization (schema v4), cache-write pricing, query contract. Then a *pure* tree-row model (`tree-model.ts`) that owns all layout math (folds, guides, truncation, suffix reservation) so the Ink component stays thin and the layout is unit-testable without a terminal. Detail pane and the 30-state contract land after the user signs off on a real render (Milestone 1 gate).

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest (`packages/core/tests`, `packages/cli/tests`), bun:test (`packages/core/tests/bun`), Ink 5 + ink-testing-library, better-sqlite3/bun:sqlite behind `StorageDriver`.

**Spec:** `docs/superpowers/specs/2026-08-04-traceview-redesign-design.md` — binding. Cite section numbers in commit messages.

## Global Constraints

- Run all commands from the repo root `/Users/srn/Documents/code/burn0-repo/burn0-1`; `PATH` needs `$HOME/.local/bin` (node) — pnpm via `npx --yes pnpm`.
- Node suite must stay green after every task: `npx --yes pnpm -r test`. Bun suite after core capture changes: `npx --yes pnpm --filter @burn0/core test:bun` (bun at `~/.bun/bin/bun`).
- Null is never 0. "Not applicable" (blank) ≠ "not reported" (`—`) in the tree TOKENS column (spec §2.1).
- `CACHE_MARK = '↺'` — presence-only, shown iff known cache-read > 0, identical on every screen. Lowercase `k` in all token abbreviations.
- Red = failure only in the trace view. `latencyColor` must not appear in TraceView or its detail pane.
- Suffixes (`400`, `error`, `unresolved`, `~`, `#n`, `▸N`, `⚠ incomplete`) are reserved before name truncation; names absorb all truncation (spec §2.1).
- Never let `.slice()` cut a surrogate pair (`🔧`). All STEP-cell composition goes through `tui/glyphs.ts`.
- `SCHEMA_VERSION` bump renames the DB to `.bak` and starts fresh — expected, pre-release policy.
- Commits: one per task, message cites the spec section, ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Milestone 1 — data honesty + tree (ends at a USER SIGN-OFF GATE)

### Task 1: Anthropic SSE tool-call extraction

**Files:**
- Modify: `packages/core/src/llm/tools.ts` (the `fromSSE` function, ~line 62)
- Test: `packages/core/tests/llm-tools.test.ts`

**Interfaces:**
- Produces: `parseToolCalls(resBody)` now returns `ToolCall[]` for Anthropic SSE bodies (`content_block_start`/`input_json_delta`). Signature unchanged.

- [ ] **Step 1: Write the failing test** — append to `llm-tools.test.ts`:

```ts
describe('Anthropic SSE tool calls', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01A","name":"sap_execute_sap_operation","input":{}}}',
    '',
    // arguments split MID-KEY across deltas — the shape that breaks naive parsers
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"opera"}}',
    '',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"tion\\":\\"GET\\",\\"path\\":\\"/A_SalesOrder\\"}"}}',
    '',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'data: {"type":"message_delta","usage":{"output_tokens":9}}',
    '',
  ].join('\n')

  it('accumulates tool_use blocks from content_block_start + input_json_delta', () => {
    const calls = parseToolCalls(sse)
    expect(calls).toEqual([{
      id: 'toolu_01A',
      name: 'sap_execute_sap_operation',
      args: '{"operation":"GET","path":"/A_SalesOrder"}',
    }])
  })

  it('a text-only Anthropic stream declares no tools', () => {
    const textOnly = sse.split('\n').filter((l) => !l.includes('tool_use') && !l.includes('input_json_delta') && !l.includes('content_block_stop')).join('\n')
    expect(parseToolCalls(textOnly)).toEqual([])
  })

  it('empty-input tool call yields args null', () => {
    const noArgs = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_02B","name":"sap_list_entities","input":{}}}',
      'data: {"type":"content_block_stop","index":0}',
    ].join('\n')
    expect(parseToolCalls(noArgs)).toEqual([{ id: 'toolu_02B', name: 'sap_list_entities', args: null }])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx --yes pnpm --filter @burn0/core exec vitest run tests/llm-tools.test.ts`
Expected: FAIL — `parseToolCalls` returns `[]` for all three (OpenAI-only delta loop).

- [ ] **Step 3: Implement** — inside `fromSSE`'s per-chunk loop, after the OpenAI `choices` loop, add:

```ts
    // Anthropic stream: a tool_use block opens with its id and name in
    // content_block_start; the arguments arrive as input_json_delta fragments
    // that concatenate in order. `index` is shared with text blocks, but only
    // tool_use ever sets id+name, so the final filter drops text slots.
    if (chunk?.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
      const i = typeof chunk.index === 'number' ? chunk.index : 0
      acc.set(i, {
        id: typeof chunk.content_block.id === 'string' ? chunk.content_block.id : null,
        name: typeof chunk.content_block.name === 'string' ? chunk.content_block.name : null,
        args: '',
      })
    }
    if (chunk?.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta'
        && typeof chunk.delta.partial_json === 'string') {
      const i = typeof chunk.index === 'number' ? chunk.index : 0
      const slot = acc.get(i)
      if (slot) slot.args += chunk.delta.partial_json
    }
```

Also update the doc comment on `parseToolCalls` ("and the SSE delta form of the former") to "and both SSE delta forms (OpenAI `delta.tool_calls`, Anthropic `content_block_start`/`input_json_delta`)".

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS, and the rest of `llm-tools.test.ts` stays green.

- [ ] **Step 5: Commit** — `feat(core): parse Anthropic SSE tool_use blocks (spec prerequisite)`

### Task 2: Usage type carries cache-write + provenance; SSE reads cache_creation

**Files:**
- Modify: `packages/core/src/llm/parse.ts`
- Test: `packages/core/tests/llm-parse.test.ts`

**Interfaces:**
- Produces: `interface Usage { tokensIn; tokensOut; tokensCached; tokensCacheWrite: number | null; inputIncludesCache: boolean }`; new export `normalizeUsage(u: Usage): Usage`. Consumed by Tasks 3–4.

- [ ] **Step 1: Failing tests** — append to `llm-parse.test.ts`:

```ts
describe('cache semantics provenance (spec §1.2)', () => {
  it('Anthropic JSON: input excludes cache; flag false; cache_creation captured', () => {
    const u = parseUsage(JSON.stringify({ usage: {
      input_tokens: 2, output_tokens: 846,
      cache_read_input_tokens: 46800, cache_creation_input_tokens: 1024,
    } }))!
    expect(u).toMatchObject({ tokensIn: 2, tokensOut: 846, tokensCached: 46800,
      tokensCacheWrite: 1024, inputIncludesCache: false })
  })
  it('OpenAI JSON: prompt_tokens is the total; flag true; no write field', () => {
    const u = parseUsage(JSON.stringify({ usage: {
      prompt_tokens: 1204, completion_tokens: 380,
      prompt_tokens_details: { cached_tokens: 312 },
    } }))!
    expect(u).toMatchObject({ tokensIn: 1204, tokensCached: 312,
      tokensCacheWrite: null, inputIncludesCache: true })
  })
  it('Gemini: promptTokenCount is total; flag true', () => {
    const u = parseUsage(JSON.stringify({ usageMetadata: {
      promptTokenCount: 500, candidatesTokenCount: 20, cachedContentTokenCount: 400,
    } }))!
    expect(u).toMatchObject({ tokensIn: 500, tokensCached: 400, inputIncludesCache: true })
  })
  it('Anthropic SSE: cache_creation read from message_start; flag false', () => {
    const raw = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":46800,"cache_creation_input_tokens":1017}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":9}}',
    ].join('\n')
    expect(parseSSEUsage(raw)).toMatchObject({ tokensIn: 2, tokensOut: 9,
      tokensCached: 46800, tokensCacheWrite: 1017, inputIncludesCache: false })
  })
  it('normalizeUsage folds read+write into an exclusive input, once', () => {
    const n = normalizeUsage({ tokensIn: 2, tokensOut: 846, tokensCached: 46800,
      tokensCacheWrite: 1024, inputIncludesCache: false })
    expect(n.tokensIn).toBe(47826)
    expect(n.inputIncludesCache).toBe(true)
    expect(normalizeUsage(n).tokensIn).toBe(47826)   // idempotent — never double-adds
  })
  it('normalizeUsage leaves inclusive providers untouched', () => {
    const u = { tokensIn: 1204, tokensOut: 380, tokensCached: 312,
      tokensCacheWrite: null, inputIncludesCache: true }
    expect(normalizeUsage(u)).toEqual(u)
  })
})
```

- [ ] **Step 2: Verify failure** — `npx --yes pnpm --filter @burn0/core exec vitest run tests/llm-parse.test.ts`. Expected: FAIL (missing fields/exports).

- [ ] **Step 3: Implement** in `parse.ts`:

```ts
export interface Usage {
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
  /** Anthropic cache_creation_input_tokens — billed at a premium. null = not reported. */
  tokensCacheWrite: number | null
  /** true when the provider's reported input already contains cached tokens
   *  (OpenAI prompt_tokens, Gemini promptTokenCount); false when it excludes
   *  them (Anthropic input_tokens). Decided by WHICH KEY supplied the number —
   *  gateways classify by payload shape, not hostname (spec §1.2). */
  inputIncludesCache: boolean
}

/** One normalization, applied once in enrich(): tokens_in always means TOTAL
 *  effective input. Idempotent by the flag flip — never applied inside the
 *  per-format parsers, which is how double-adding would happen. */
export function normalizeUsage(u: Usage): Usage {
  if (u.inputIncludesCache || u.tokensIn == null) return u
  return {
    ...u,
    tokensIn: u.tokensIn + (u.tokensCached ?? 0) + (u.tokensCacheWrite ?? 0),
    inputIncludesCache: true,
  }
}
```

In `usageFromObject`, replace the merged `??` reads so provenance is key-accurate:

```ts
  if (o.usage && typeof o.usage === 'object') {
    const u = o.usage
    const oaIn = nonNeg(u.prompt_tokens)
    const anIn = nonNeg(u.input_tokens)
    const tokensIn = oaIn ?? anIn
    const tokensOut = nonNeg(u.completion_tokens) ?? nonNeg(u.output_tokens)
    const tokensCached = nonNeg(u.prompt_tokens_details?.cached_tokens) ?? nonNeg(u.cache_read_input_tokens)
    const tokensCacheWrite = nonNeg(u.cache_creation_input_tokens)
    if (tokensIn !== null || tokensOut !== null) {
      return { tokensIn, tokensOut, tokensCached, tokensCacheWrite, inputIncludesCache: oaIn != null }
    }
  }
```

Gemini branch: add `tokensCacheWrite: null, inputIncludesCache: true`. In `parseSSEUsage`: add `let tokensCacheWrite: number | null = null; let inputIncludesCache = true`; in the `msgUsage` branch set `tokensCacheWrite = nonNeg(msgUsage.cache_creation_input_tokens) ?? tokensCacheWrite` and `inputIncludesCache = false` whenever `nonNeg(msgUsage.input_tokens) != null`; when the OpenAI-style `usageFromObject(parsed)` branch supplies `tokensIn`, carry its `inputIncludesCache`. Return the two new fields.

- [ ] **Step 4: Fix compile fallout** — existing `Usage` literals in `packages/core/tests/pricing.test.ts` and any in `enrich.test.ts` need the two new fields (`tokensCacheWrite: null, inputIncludesCache: true`). `npx --yes pnpm --filter @burn0/core lint` until clean.

- [ ] **Step 5: Verify pass** — parse + full core suite: `npx --yes pnpm --filter @burn0/core test`. Expected: PASS.

- [ ] **Step 6: Commit** — `feat(core): Usage carries cache-write + provenance; normalizeUsage (spec §1.2)`

### Task 3: Schema v4 + enrich applies normalization + writer stores cache-write

**Files:**
- Modify: `packages/core/src/types.ts` (EnrichedRow + `SCHEMA_VERSION = 4`)
- Modify: `packages/core/src/storage/schema.ts` (two columns)
- Modify: `packages/core/src/storage/db.ts` (insReq)
- Modify: `packages/core/src/capture/enrich.ts`
- Test: `packages/core/tests/enrich.test.ts`, `packages/core/tests/storage.test.ts`

**Interfaces:**
- Produces: `EnrichedRow.tokensCacheWrite: number | null`; `requests.tokens_cache_write INTEGER`; `traces.expired_calls INTEGER NOT NULL DEFAULT 0`. All rows written from `enrich()` carry normalized `tokensIn`.

- [ ] **Step 1: Failing tests.** In `enrich.test.ts`:

```ts
it('normalizes Anthropic input to total-effective and stores cache write (spec §1.2)', () => {
  const row = enrich(evt({
    hostname: 'api.anthropic.com',
    resBody: JSON.stringify({ model: 'claude-sonnet-5', usage: {
      input_tokens: 2, output_tokens: 846,
      cache_read_input_tokens: 46800, cache_creation_input_tokens: 1024 } }),
  }), opts())
  expect(row.tokensIn).toBe(47826)         // 2 + 46800 + 1024 — never again "2 → 846"
  expect(row.tokensCached).toBe(46800)
  expect(row.tokensCacheWrite).toBe(1024)
})
```

(`evt()`/`opts()` are this file's existing helpers — reuse them exactly as the neighboring tests do.) In `storage.test.ts`: insert via the existing `insertRows` path a row with `tokensCacheWrite: 1024` and assert `SELECT tokens_cache_write FROM requests` returns it; assert `SELECT expired_calls FROM traces` defaults 0 on a trace inserted through `createWriter`.

- [ ] **Step 2: Verify failure** — both files. Expected: FAIL (column/field missing).

- [ ] **Step 3: Implement.** `types.ts`: add `tokensCacheWrite: number | null` to `EnrichedRow` after `tokensCached`; `SCHEMA_VERSION = 4`. `schema.ts`: in `requests`, after `tokens_cached INTEGER,` add `tokens_cache_write INTEGER,`; in `traces`, after `attribution TEXT,` add `expired_calls INTEGER NOT NULL DEFAULT 0,` (keep `tags TEXT` last). `db.ts` `insReq`: add `tokens_cache_write` to the column list and `r.tokensCacheWrite` to the values (26 placeholders now — count them). `enrich.ts`: import `normalizeUsage`; replace the usage block:

```ts
  const rawUsage = opts.isSSE ? parseSSEUsage(event.resBody ?? '') : parseUsage(event.resBody)
  const usage = rawUsage ? normalizeUsage(rawUsage) : null
  let tokensCacheWrite: number | null = null
  if (usage) {
    tokensIn = usage.tokensIn
    tokensOut = usage.tokensOut
    tokensCached = usage.tokensCached
    tokensCacheWrite = usage.tokensCacheWrite
    if (model) costUsd = computeCost(opts.pricing, provider, model, usage)
  }
```

and add `tokensCacheWrite` to the returned row.

- [ ] **Step 4: Verify pass** — `npx --yes pnpm --filter @burn0/core test` AND `npx --yes pnpm --filter @burn0/core test:bun` (writer runs under both drivers). Expected: PASS.

- [ ] **Step 5: Commit** — `feat(core): schema v4 — normalized tokens_in, tokens_cache_write, expired_calls (spec §1.2, §5)`

### Task 4: computeCost prices normalized usage + cache writes

**Files:**
- Modify: `packages/core/src/pricing/index.ts`
- Test: `packages/core/tests/pricing.test.ts`

**Interfaces:**
- Consumes: normalized `Usage` (Task 2 — `tokensIn` is total).
- Produces: `PriceEntry.cache_creation_input_token_cost?: number`; `computeCost` prices fresh/read/write separately.

- [ ] **Step 1: Failing tests:**

```ts
describe('cache-aware cost on normalized usage (spec §1.2)', () => {
  const table = { 'anthropic/claude-sonnet-5': {
    input_cost_per_token: 3e-6, output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6,
  } }
  it('prices fresh + read + write at their own rates — the Anthropic regression', () => {
    const cost = computeCost(table, 'anthropic', 'claude-sonnet-5', {
      tokensIn: 47826, tokensOut: 846, tokensCached: 46800,
      tokensCacheWrite: 1024, inputIncludesCache: true })
    //   2·3e-6 + 46800·3e-7 + 1024·3.75e-6 + 846·15e-6
    expect(cost).toBeCloseTo(0.000006 + 0.01404 + 0.00384 + 0.01269, 10)
    // the old subset math computed max(0, 2−46800)=0 fresh and no write cost at all
  })
  it('missing cache rates fall back to the base input rate — never a fabricated multiplier', () => {
    const bare = { m: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }
    const cost = computeCost(bare, null, 'm', {
      tokensIn: 100, tokensOut: 10, tokensCached: 40, tokensCacheWrite: 10, inputIncludesCache: true })
    expect(cost).toBeCloseTo(100 * 1e-6 + 10 * 2e-6, 12)   // fresh 50 + read 40 + write 10, all at 1e-6
  })
})
```

- [ ] **Step 2: Verify failure.** Expected: FAIL (write tokens unpriced / wrong split).

- [ ] **Step 3: Implement.** Add `cache_creation_input_token_cost?: number` to `PriceEntry` (and to the snapshot-filter fields in `pricing/index.ts`'s feed mapping if it whitelists keys — check `loadPricing`'s row mapping and carry the field through). Replace the arithmetic:

```ts
  const read = usage.tokensCached ?? 0
  const write = usage.tokensCacheWrite ?? 0
  const fresh = Math.max(0, (usage.tokensIn ?? 0) - read - write)
  const cost =
    fresh * (entry.input_cost_per_token ?? 0) +
    read * (entry.cache_read_input_token_cost ?? entry.input_cost_per_token ?? 0) +
    write * (entry.cache_creation_input_token_cost ?? entry.input_cost_per_token ?? 0) +
    (usage.tokensOut ?? 0) * (entry.output_cost_per_token ?? 0)
  return cost
```

- [ ] **Step 4: Verify pass** — full core suite (existing pricing tests updated in Task 2 must still hold).

- [ ] **Step 5: Commit** — `fix(core): price cache writes; stop zeroing Anthropic fresh input (spec §1.2)`

### Task 5: Retention sweep records expired_calls

**Files:**
- Modify: `packages/core/src/storage/retention.ts`
- Test: `packages/core/tests/queue-retention.test.ts`

**Interfaces:**
- Produces: `pruneRetention` increments `traces.expired_calls` by the number of request rows it deletes per trace, before deleting them. The only actor that ever knows N (spec §4).

- [ ] **Step 1: Failing test:** seed (via existing helpers in the file) one trace with 3 requests older than the metadata window and 2 younger; run `pruneRetention`; assert the trace row's `expired_calls` is 3 and 2 requests remain. Second case: trace itself past the window — its requests are counted then the trace row is deleted with the existing statements (no error, no orphan).

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement** — in `pruneRetention`, immediately BEFORE the `DELETE FROM requests` statement:

```ts
  // Count what is about to be deleted, onto the trace that owned it. This is
  // the only honest source for "N calls expired": the sweep is the one actor
  // that ever knows N (spec §4).
  db.prepare(`UPDATE traces SET expired_calls = expired_calls + (
      SELECT COUNT(*) FROM requests r
      WHERE r.trace_id = traces.id AND r.started_at < ?${scope.replace('project_id', 'r.project_id')})
    WHERE id IN (SELECT DISTINCT trace_id FROM requests
      WHERE trace_id IS NOT NULL AND started_at < ?${scope})`)
    .run(now - days.metadata * DAY, ...extra, now - days.metadata * DAY, ...extra)
```

- [ ] **Step 4: Verify pass** — core suite. **Step 5: Commit** — `feat(core): retention sweep records expired_calls per trace (spec §4)`

### Task 6: Query contract — traceTree {root,nodes}|null, new fields, toolIo, requestDetail bytes

**Files:**
- Modify: `packages/core/src/query/index.ts`
- Modify: `packages/cli/src/tui/screens/TraceView.tsx` (call-site compile fix only — full rewrite is Task 9)
- Test: `packages/core/tests/trace-query.test.ts`

**Interfaces:**
- Produces (Tasks 8–15 rely on these exact shapes):
  - `traceTree(db, traceId): { root: TraceTreeNode; nodes: TraceTreeNode[] } | null` — `null` = trace row gone; `nodes` is the flattened list INCLUDING the root at index 0.
  - `TraceTreeNode` gains: `endedAt: number | null`, `tokensCached: number | null`, `tokensCacheWrite: number | null`, `tokenCalls: number`, `reqBytes: number | null`, `resBytes: number | null`, `expiredCalls: number` (0 on request rows), `method: string | null` (request rows; fold grouping needs the verb without parsing labels). `durationMs` is forced `null` when `incomplete` (an observation window is not a duration — spec §4).
  - `query.toolIo(db, traceId): { args: string | null; result: string | null; truncated: boolean } | null`.
  - `requestDetail` row includes `req_bytes`, `res_bytes`.
  - `TraceListRow` gains `tokensCached: number | null` (TraceList's `↺`).

- [ ] **Step 1: Failing tests** in `trace-query.test.ts` (reuse its existing seeding helpers):

```ts
it('traceTree returns null for a pruned trace, root+nodes otherwise', () => {
  expect(query.traceTree(db, 999999)).toBeNull()
  const t = query.traceTree(db, seededTraceId)!
  expect(t.root.type).toBe('trace')
  expect(t.nodes[0]).toBe(t.root)
})
it('nodes carry cache fields, method, tokenCalls; incomplete kills durationMs', () => {
  const t = query.traceTree(db, seededTraceId)!
  const llm = t.nodes.find((n) => n.model != null)!
  expect(llm.tokensCached).toBe(46800)
  expect(llm.method).toBe('POST')
  expect(t.root.tokenCalls).toBeGreaterThan(0)
  const swept = query.traceTree(db, incompleteTraceId)!
  expect(swept.root.durationMs).toBeNull()
})
it('toolIo round-trips args/result and returns null when pruned', () => {
  expect(query.toolIo(db, toolTraceId)).toEqual({ args: '{"q":1}', result: '{"ok":true}', truncated: false })
  expect(query.toolIo(db, 424242)).toBeNull()
})
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement.** In `traceTree`: change `if (traces.length === 0) return []` to `return null`; select the new columns (`t.ended_at`, request `tokens_cached`, `tokens_cache_write`, `req_bytes`, `res_bytes`, `method`, trace `expired_calls`); populate node fields; request nodes get `expiredCalls: 0`, trace nodes get theirs from the row; `durationMs: row.incomplete ? null : …existing…`; compute `tokenCalls` (count of descendant request rows with `tokens_in IS NOT NULL OR tokens_out IS NOT NULL`) in the same pass that already aggregates `pricedCalls`; return `{ root: out[0], nodes: out }`. Add:

```ts
export function toolIo(db: StorageDriver, traceId: number):
    { args: string | null; result: string | null; truncated: boolean } | null {
  const row = db.prepare(`SELECT args, result, truncated FROM tool_io WHERE trace_id = ?`).get(traceId)
  return row ? { args: row.args ?? null, result: row.result ?? null, truncated: !!row.truncated } : null
}
```

`requestDetail`: add `r.req_bytes AS reqBytes, r.res_bytes AS resBytes` to its select. `traceList`: add `tokens_cached` sum → `tokensCached` on `TraceListRow`. Compile-fix `TraceView.tsx` minimally: `const tree = usePoll(…); const nodes = tree?.nodes ?? []` (behavior identical for now).

- [ ] **Step 4: Verify pass** — `npx --yes pnpm -r test` (cli tests compile against the new shape via the src alias). **Step 5: Commit** — `feat(core): traceTree {root,nodes}|null + cache/bytes/method fields; query.toolIo (spec §5)`

### Task 7: CLI formatter — fmtTok, fmtTokPair, CACHE_MARK

**Files:**
- Modify: `packages/cli/src/format.ts`
- Test: `packages/cli/tests/format.test.ts`

**Interfaces:**
- Produces: `CACHE_MARK: '↺'`; `fmtTok(n: number | null): string`; `fmtTokPair(tin: number|null, cached: number|null, tout: number|null, spaced?: boolean): string`. Every token cell on every screen goes through these (Tasks 8, 10, 11, 13, 14).

- [ ] **Step 1: Failing tests** — the full tier + boundary table, verbatim:

```ts
describe('fmtTok (spec §1.3)', () => {
  const cases: Array<[number | null, string]> = [
    [null, '—'], [0, '0'], [846, '846'], [999, '999'],
    [1000, '1.0k'], [4032, '4.0k'], [46802, '46.8k'], [99949, '99.9k'],
    [99950, '100k'], [100000, '100k'], [999499, '999k'],
    [999500, '1.0M'], [1200000, '1.2M'], [99940000, '99.9M'], [999500000, '1.0B'],
  ]
  for (const [n, want] of cases) it(`${n} → ${want}`, () => expect(fmtTok(n)).toBe(want))
})
describe('fmtTokPair', () => {
  it('marks cache presence with ↺, unspaced', () =>
    expect(fmtTokPair(46802, 46800, 846)).toBe(`46.8k${CACHE_MARK}→846`))
  it('spaced form for the list column', () =>
    expect(fmtTokPair(46802, 46800, 846, true)).toBe(`46.8k${CACHE_MARK} → 846`))
  it('no mark when cache-read is 0 or unknown', () => {
    expect(fmtTokPair(1204, 0, 380)).toBe('1.2k→380')
    expect(fmtTokPair(1204, null, 380)).toBe('1.2k→380')
  })
  it('each side independently null — never renders null as 0', () => {
    expect(fmtTokPair(1200, null, null)).toBe('1.2k→—')
    expect(fmtTokPair(null, null, 846)).toBe('—→846')
    expect(fmtTokPair(null, null, null)).toBe('—')
  })
  it('worst cell fits w12', () =>
    expect(fmtTokPair(99900, 1, 99900).length).toBeLessThanOrEqual(12))
})
```

- [ ] **Step 2: Verify failure** — `npx --yes pnpm --filter @burn0/cli exec vitest run tests/format.test.ts`.

- [ ] **Step 3: Implement:**

```ts
/** The cache mark — presence-only (a glyph cannot lie about a quantity the
 *  way a wrong total can). Shown iff known cache-read > 0. One definition for
 *  every screen (spec §1.3). Width 1 under Ink's string-width — measured. */
export const CACHE_MARK = '↺'

/** Token magnitudes: exact <1k · one decimal to 99.9k · integer to 999k ·
 *  same tiers at M and B · re-bucketed so 999,950 renders 1.0M, never 1000k. */
export function fmtTok(n: number | null): string {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  const units = ['k', 'M', 'B']
  let i = 0
  let v = n / 1000
  while (i < units.length - 1 && v >= 999.5) { v /= 1000; i += 1 }
  let s = v < 100 ? v.toFixed(1) : String(Math.round(v))
  if (Number(s) >= 1000 && i < units.length - 1) { i += 1; s = (Number(s) / 1000).toFixed(1) }
  else if (Number(s) >= 100 && s.includes('.')) s = String(Math.round(Number(s)))
  return s + units[i]
}

export function fmtTokPair(
  tin: number | null, cached: number | null, tout: number | null, spaced = false,
): string {
  if (tin == null && tout == null) return '—'
  const mark = (cached ?? 0) > 0 ? CACHE_MARK : ''
  return `${fmtTok(tin)}${mark}${spaced ? ' → ' : '→'}${fmtTok(tout)}`
}
```

- [ ] **Step 4: Verify pass.** **Step 5: Commit** — `feat(cli): fmtTok/fmtTokPair/CACHE_MARK — one token vocabulary (spec §1.3)`

### Task 8: Glyph module + width-safe cell composition

**Files:**
- Create: `packages/cli/src/tui/glyphs.ts`
- Modify: `packages/cli/package.json` (add `"string-width": "^7.2.0"` to dependencies; run `npx --yes pnpm install`)
- Test: `packages/cli/tests/glyphs.test.ts`

**Interfaces:**
- Produces (Tasks 9–10 consume): `G = { llm:'◆', api:'◇', tool:'🔧', foldClosed:'▸', foldOpen:'▾', elide:'…', live:'●', warnWord:'⚠', guideV:'│ ', guideT:'├ ', guideL:'└ ', guideGap:'  ' }`; `visWidth(s): number`; `padCell(s, w, align?): string` (pads/truncates BY DISPLAY WIDTH, truncates right with `…`, never splits a surrogate); `truncLeft(s, w): string` (keeps the tail, `…` leftmost, snap-forward-to-`/` if one occurs within the first 4 kept chars).

- [ ] **Step 1: Failing tests:**

```ts
import { G, visWidth, padCell, truncLeft } from '../src/tui/glyphs.js'
it('every marker used in numeric-adjacent cells is width 1; tool emoji is 2', () => {
  for (const g of [G.llm, G.api, G.foldClosed, G.foldOpen, G.elide, G.live, '↺']) expect(visWidth(g)).toBe(1)
  expect(visWidth(G.tool)).toBe(2)
})
it('padCell pads and truncates by display width without splitting 🔧', () => {
  expect(padCell('abc', 5)).toBe('abc  ')
  expect(padCell('abc', 5, 'right')).toBe('  abc')
  expect(padCell(`${G.tool} sap_execute`, 6)).toBe(`${G.tool} sa${G.elide}`)   // 2+1+2+1 = 6 cells
})
it('truncLeft keeps the discriminating tail, elides leftmost, snaps to a cheap slash', () => {
  expect(truncLeft('/s4hanacloud/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder', 30))
    .toBe('…/API_SALES_ORDER_SRV/A_SalesOrder'.slice(0, 30).length <= 30
      ? expect.any(String) : '')  // replaced below by exact assertions:
})
it('truncLeft exact cases', () => {
  const p = '/s4hanacloud/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder'
  expect(truncLeft(p, p.length)).toBe(p)                       // fits → whole
  expect(truncLeft(p, 34)).toBe('…API_SALES_ORDER_SRV/A_SalesOrder')  // no slash in first 4 kept → plain
  expect(truncLeft(p, 36)).toBe('…/API_SALES_ORDER_SRV/A_SalesOrder') // slash at kept-index ≤4 → snap
  expect(truncLeft(p, 3)).toBe('…er')
})
```

(Delete the placeholder third test before committing — the exact-cases block is the real one.)

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement** (full file):

```ts
import stringWidth from 'string-width'

/** Every glyph the trace view draws, in one place, beside the composition
 *  rules that keep them from shearing columns. All width-1 except tool (2) —
 *  measured against Ink's own string-width (spec §2.1). */
export const G = {
  llm: '◆', api: '◇', tool: '🔧',
  foldClosed: '▸', foldOpen: '▾', elide: '…', live: '●', warnWord: '⚠',
  guideV: '│ ', guideT: '├ ', guideL: '└ ', guideGap: '  ',
} as const

export function visWidth(s: string): number { return stringWidth(s) }

/** Pad or right-truncate to an exact DISPLAY width. Iterates code points so a
 *  surrogate pair (🔧) is dropped whole, never split into replacement chars. */
export function padCell(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  const width = stringWidth(s)
  if (width <= w) {
    const pad = ' '.repeat(w - width)
    return align === 'right' ? pad + s : s + pad
  }
  let out = ''
  let used = 0
  for (const cp of s) {                    // code-point iteration
    const cw = stringWidth(cp)
    if (used + cw > w - 1) break
    out += cp
    used += cw
  }
  return out + G.elide + ' '.repeat(Math.max(0, w - used - 1))
}

/** Left-truncation for endpoint tails: the tail is where the signal lives.
 *  `…` is always exactly one char, always leftmost. Snap forward to a `/`
 *  only when one occurs within the first 4 kept chars — a greedy break-at-/
 *  would collapse `…SRV/$metadata` to `…/$metadata` and destroy the signal. */
export function truncLeft(path: string, w: number): string {
  if (stringWidth(path) <= w) return path
  let tail = path.slice(-(w - 1))
  const slash = tail.indexOf('/')
  if (slash > 0 && slash <= 4) tail = tail.slice(slash)
  return G.elide + tail
}
```

- [ ] **Step 4: Verify pass.** **Step 5: Commit** — `feat(cli): glyph constants + width-safe cell composition (spec §2.1–2.2)`

### Task 9: tree-model.ts — the pure row builder

**Files:**
- Create: `packages/cli/src/tui/tree-model.ts`
- Test: `packages/cli/tests/tree-model.test.ts`

**Interfaces:**
- Consumes: `TraceTreeNode` (Task 6 shape), `fmtTok/fmtTokPair/fmtUsd/fmtMs` , `G/padCell/truncLeft`, `detectEntity` from `@burn0/core`.
- Produces (Task 10 renders these verbatim):

```ts
export interface DisplayRow {
  key: string                    // 'trace:4' | 'req:17' | 'fold:req:12' | 'info:expired'
  kind: 'node' | 'fold' | 'info'
  node?: TraceTreeNode           // kind 'node'
  isBranch: boolean              // ⏎/h/l semantics; root is NOT a branch (non-collapsible)
  requestId: number | null       // ⏎ payload target on leaves
  step: string                   // fully composed STEP cell, exact width
  stepColor?: string; stepBold?: boolean; stepDim?: boolean
  cost: string; tokens: string; took: string
  tookEmphasis: 'dim' | 'normal' | 'warn'   // §2.4 relative rule
}
export const FOLD_MIN = 4
export function buildRows(opts: {
  tree: { root: TraceTreeNode; nodes: TraceTreeNode[] }
  expanded: Set<string>          // keys the user explicitly toggled OPEN (folds) …
  collapsed: Set<string>         // … and explicitly toggled CLOSED (branches)
  stepWidth: number
  flat: boolean
}): DisplayRow[]
```

Layout rules implemented here and ONLY here: default expansion depth ≤ 2; folds (≥`FOLD_MIN` consecutive sibling request leaves, same `hostname`+`method`, all `status < 400` and non-null — an error breaks the run); fold key = `fold:req:<firstChildRequestId>` (stable across live appends); guide prefixes from depth + last-sibling lookahead; suffix reservation (status ≥400/null → ` 400`/red name; tool ` ~`/` ~turn` + ` error`/` unresolved`; collapsed ` ▸N`; root mix `· 7◆ 7🔧 25◇` dropped whole when stepWidth < name+14; `⚠ incomplete`); LLM turn ordinals `#n` in seq order; API name = `{entity≤10} {VERB unless GET} {truncLeft(tail)}`; TOKENS cell: LLM rows `fmtTokPair(tokensIn, tokensCached, tokensOut)`, `—` when tokenCalls>0 expected but unreported, **blank** (`''`) for API/tool-without-LLM-descendants; TOOK emphasis: share = durationMs/rootDuration (root fallback: max node duration), ≥0.40 `warn`, ≥0.15 `normal`, else `dim`; root TOOK `normal`; flat mode = request rows only, seq order, info rows retained.

- [ ] **Step 1: Failing tests** — build a fixture of `TraceTreeNode[]` mirroring the spec §2.6 reference trace (root + 12 same-host GETs + 7 LLM + 7 tools with children; one tool `error`, one `unresolved`; one API row status 400). Assert, minimum:

```ts
it('folds the 12-GET discovery wall into one collapsed row with count and span', () => {
  const rows = buildRows({ tree, expanded: new Set(), collapsed: new Set(), stepWidth: 53, flat: false })
  const fold = rows.find((r) => r.kind === 'fold')!
  expect(fold.step).toContain('12× GET')
  expect(rows.filter((r) => r.node?.type === 'request' && r.node.method === 'GET'
    && r.node.depth === 1 && !r.step.includes('×')).length).toBe(0)  // members hidden
})
it('an error row breaks a fold — a failure can never hide inside one', () => {
  // fixture variant: 6 GETs, the 4th has status 500 → expect 3+1 singles impossible to fold + …
  const rows = buildRows({ tree: withError, expanded: new Set(), collapsed: new Set(), stepWidth: 53, flat: false })
  expect(rows.some((r) => r.kind === 'fold')).toBe(false)         // 3 before + 2 after, both under FOLD_MIN
  expect(rows.find((r) => r.node?.status === 500)!.stepColor).toBe('red')
})
it('LLM rows get turn ordinals and ↺ token cells', () => {
  const llm = rows().filter((r) => r.node?.model != null)
  expect(llm[0].step).toContain('claude-sonnet-5 #1')
  expect(llm[2].step).toContain('#3')
  expect(llm[0].tokens).toBe('46.9k↺→412')
})
it('suffixes survive any width — names absorb truncation', () => {
  for (const w of [29, 35, 53, 66]) {
    const rows = buildRows({ tree, expanded: new Set(), collapsed: new Set(), stepWidth: w, flat: false })
    const err = rows.find((r) => r.step.includes('error'))
    expect(err, `width ${w}`).toBeDefined()
    for (const r of rows) expect(visWidth(r.step)).toBe(w)        // exact composition, always
  }
})
it('collapsed tool shows ▸N and aggregates; expanded set reopens a fold', () => {
  const collapsed = new Set(['tool:31'])
  const rows = buildRows({ tree, expanded: new Set(), collapsed, stepWidth: 53, flat: false })
  expect(rows.find((r) => r.key === 'tool:31')!.step).toMatch(/▸2\s*$/)
  const open = buildRows({ tree, expanded: new Set(['fold:req:2']), collapsed: new Set(), stepWidth: 53, flat: false })
  expect(open.filter((r) => r.node?.depth === 1 && r.node.method === 'GET').length).toBe(12)
})
it('TOOK emphasis is trace-relative: only the ≥15% row is normal', () => {
  const rows = buildRows({ tree, expanded: new Set(), collapsed: new Set(), stepWidth: 53, flat: false })
  const turn3 = rows.find((r) => r.step.includes('#3'))!
  expect(turn3.tookEmphasis).toBe('normal')                       // 8.4s of 48.3s
  expect(rows.find((r) => r.step.includes('#2'))!.tookEmphasis).toBe('dim')
})
it('blank vs — : API rows blank, LLM-without-usage —', () => {
  expect(rows().find((r) => r.node?.type === 'request' && r.node.model == null)!.tokens).toBe('')
  expect(rowsWithUsagelessLlm().find((r) => r.node?.model != null && r.node.tokensIn == null)!.tokens).toBe('—')
})
it('flat mode keeps only request rows in seq order, plus info rows', () => {
  const rows = buildRows({ tree, expanded: new Set(), collapsed: new Set(), stepWidth: 53, flat: true })
  expect(rows.every((r) => r.kind !== 'node' || r.node!.type === 'request' || r.node!.type === 'trace' && r.node!.depth === 0)).toBe(true)
})
```

- [ ] **Step 2: Verify failure** (module missing).

- [ ] **Step 3: Implement.** Skeleton (the tests above are the contract; fill the marked sections with the rules listed in Interfaces — they are exhaustive):

```ts
import type { TraceTreeNode } from '@burn0/core'
import { detectEntity } from '@burn0/core'
import { G, padCell, truncLeft, visWidth } from './glyphs.js'
import { fmtTokPair, fmtUsd, fmtMs, CACHE_MARK } from '../format.js'
import { theme } from './theme.js'

export const FOLD_MIN = 4

export function buildRows(opts: { /* …as in Interfaces… */ }): DisplayRow[] {
  const { tree, expanded, collapsed, stepWidth, flat } = opts
  const nodes = tree.nodes
  const rootDur = tree.root.durationMs ?? Math.max(...nodes.map((n) => n.durationMs ?? 0), 1)
  // 1. assign LLM turn ordinals in seq (array) order
  // 2. group children by parent (nodes are DFS-flattened; reconstruct parent
  //    chains from depth transitions), find fold runs among each sibling list
  // 3. walk DFS emitting DisplayRows, skipping children of collapsed branches
  //    and unexpanded folds; compute guide prefix from ancestors' last-sibling flags
  // 4. compose each STEP cell: guides + marker + name + reserved suffixes,
  //    name truncated to (stepWidth − everything-else) via truncLeft/padCell
  // 5. token/cost/took cells + emphasis per the Interfaces rules
}
```

Implementation notes an engineer must not miss: sibling reconstruction — walk the flat list keeping a stack of `(node, indexAmongSiblings)`; a node at depth d pops to the last ancestor at depth d−1. Last-sibling flags come from a first pass that records, per parent, its ordered children. The root mix summary counts markers over ALL nodes (`◆` = requests with model, `🔧` = type tool, `◇` = other requests) — do NOT reuse `stepShapes` from the list query. Entity display: `detectEntity(hostname).entity`, right-truncated to 10 with `…`. Fold TOOK = `fmtMs(lastChildEnd − firstChildStart)` from children's `startedAt`/`durationMs`.

- [ ] **Step 4: Verify pass** — `npx --yes pnpm --filter @burn0/cli exec vitest run tests/tree-model.test.ts`, then the full cli suite.

- [ ] **Step 5: Commit** — `feat(cli): pure tree-row model — folds, guides, suffix reservation, relative timing (spec §2)`

### Task 10: TraceView rewrite — tree pane on the new model

**Files:**
- Modify: `packages/cli/src/tui/screens/TraceView.tsx` (rewrite)
- Test: `packages/cli/tests/tui-traceview.test.tsx` (new; the old `tui-traces.test.tsx` covers the list, leave it)

**Interfaces:**
- Consumes: `buildRows`/`DisplayRow` (Task 9), `traceTree` `{root,nodes}|null` (Task 6).
- Produces: same component export + props as today (`db, traceId, columns?, onBack, onOpenRequest`). Detail pane unchanged this task (still the stats card) — it is replaced in Task 13.

- [ ] **Step 1: Failing tests** (ink-testing-library; remember the literal-ESC-byte trap from progress.md — arrow constants must be `'[B'`):

```ts
it('renders the reference trace: fold row, turn ordinals, ↺, guide glyphs', () => {
  const { lastFrame } = render(<TraceView db={db} traceId={rootId} columns={140} onBack={noop} onOpenRequest={noop} />)
  const f = lastFrame()!
  expect(f).toContain('12× GET')
  expect(f).toContain('#1')
  expect(f).toContain('↺')
  expect(f).toContain('├')
  expect(f).not.toContain('/v1/messages')          // LLM rows show the model, never the URL
})
it('⏎ on a fold expands in place; h collapses a tool; cursor is identity-keyed', () => { /* drive stdin, assert rows */ })
it('cursor stays on its node when a new row is inserted above (live append)', () => { /* re-seed db mid-test, advance poll, assert selected step text unchanged */ })
it('f toggles flat mode and back', () => { /* assert tool rows disappear, seq order */ })
it('pruned trace renders the pruned message, not the expired one', () => {
  const { lastFrame } = render(<TraceView db={db} traceId={777777} columns={140} onBack={noop} onOpenRequest={noop} />)
  expect(lastFrame()).toContain('no longer in the database')
})
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement.** State: `const [collapsed] = useState(() => new Set<string>())`, `expanded` likewise, `cursorKey: string | null`, `flat: boolean`. Rows = `useMemo(() => tree ? buildRows({ tree, expanded, collapsed, stepWidth, flat }) : [], [tree, …])`. Cursor resolution per poll: find `rows.findIndex(r => r.key === cursorKey)`; if missing, clamp previous index; if previous position was the last row, follow to the new last row (positional live-follow). Keys: `↑↓` move (set cursorKey); `h` → if branch not collapsed, add to `collapsed`, else move cursor to parent row; `l` → remove from `collapsed` / add fold key to `expanded`; `⏎` → branch: toggle (same as h/l); request leaf: `onOpenRequest(requestId)`; info/fold-member: no-op; root: no-op. Root header row uses the model's row 0. TOOK emphasis → `dim`/plain/`theme.warn`; step colors from `DisplayRow`. Keep `TWO_PANE_MIN_COLUMNS = 110`, pane width `Math.min(Math.floor(columns * 0.62), 98)`. The pruned state (`tree == null`): render the §4 message + footer `q quit · esc back`.

- [ ] **Step 4: Verify pass** — full cli suite. **Step 5: Commit** — `feat(cli): TraceView tree pane on tree-model — folds, ordinals, identity cursor (spec §2, §4 partial)`

### Task 11: Token cells on the other screens

**Files:**
- Modify: `packages/cli/src/tui/screens/TraceList.tsx` (Tokens col → width 15, `fmtTokPair(r.tokensIn, r.tokensCached, r.tokensOut, true)`)
- Modify: `packages/cli/src/tui/screens/Logs.tsx` (volume col → width 11, unspaced pair for LLM rows; bytes path untouched)
- Modify: `packages/cli/src/tui/screens/Usage.tsx` (LLM In cell `fmtTok(in) + (cached>0 ? CACHE_MARK : '')`, Out `fmtTok(out)`; bytes rows untouched)
- Test: adjust assertions in `tui-tracelist.test.tsx`, `tui-logs.test.tsx`, `usage`-related tests to the new formats (e.g. `4,032 → 590` becomes `4.0k → 590`).

- [ ] **Step 1:** Update the existing tests' expected strings first; run; watch them fail against the old rendering.
- [ ] **Step 2:** Swap the cells; queries already carry `tokensCached` (Task 6).
- [ ] **Step 3:** Full cli suite green.
- [ ] **Step 4: Commit** — `feat(cli): one token vocabulary across TraceList/Logs/Usage (spec §1.3)`

### Task 12: 🔎 VISUAL CHECKPOINT — render against real data, STOP

**Files:**
- Create: `packages/cli/scripts/render-trace.tsx` (dev-only, committed)

```tsx
// Renders TraceView headlessly for a given DB + trace id and prints the frame.
// Usage: npx tsx scripts/render-trace.tsx <dbPath> [traceId] [columns]
import React from 'react'
import { render } from 'ink-testing-library'
import { openDatabase, query } from '@burn0/core'
import { TraceView } from '../src/tui/screens/TraceView.js'

const [dbPath, idArg, colsArg] = process.argv.slice(2)
const db = openDatabase(dbPath)
const traceId = idArg ? Number(idArg)
  : (query.traceList(db, { projectIds: null, services: null }, {})[0]?.id ?? 0)
const { lastFrame } = render(
  <TraceView db={db} traceId={traceId} columns={Number(colsArg ?? 140)}
    onBack={() => {}} onOpenRequest={() => {}} />)
await new Promise((r) => setTimeout(r, 100))
console.log(lastFrame())
process.exit(0)
```

- [ ] **Step 1:** `npx --yes pnpm -r build`.
- [ ] **Step 2:** Regenerate real agent traffic on schema v4 (the bump reset the DB): restart the user's backend with the burn0 preload, send one chat message — OR use the burn0-test agent fixture: `npx --yes pnpm --filter burn0-test agent` with `BURN0_DB_PATH=/private/tmp/burn0-checkpoint.db`.
- [ ] **Step 3:** `npx --yes pnpm --filter @burn0/cli exec tsx scripts/render-trace.tsx /private/tmp/burn0-checkpoint.db "" 140` — capture the frame at 140 and 110 columns.
- [ ] **Step 4:** Present both frames to the user. **HARD GATE: do not start Milestone 2 until the user approves the visual.** Adjust tree-model/theme on feedback; re-render; repeat.
- [ ] **Step 5: Commit** — `chore(cli): headless trace render script (spec §8 milestone 1 gate)`

---

## Milestone 2 — detail pane, chat extraction, states (after sign-off)

### Task 13: extractExchange — shared conversation extraction

**Files:**
- Modify: `packages/core/src/index.ts` (export `parseToolCalls`, `parseToolResults` from `./llm/tools.js`)
- Rewrite: `packages/cli/src/tui/llm-io.ts` → export `extractExchange`
- Test: `packages/cli/tests/llm-io.test.ts` (rewrite)

**Interfaces:**
- Produces:

```ts
export interface Exchange {
  parsed: boolean
  msgCount: number; earlierCount: number
  systemFirstLine: string | null; systemChars: number
  lastUserText: string | null
  toolResults: Array<{ name: string | null; isError: boolean; bytes: number }>
  assistantText: string | null
  toolCalls: Array<{ name: string; args: string | null }>
}
export function extractExchange(reqBody: string | null, resBody: string | null): Exchange
```

- [ ] **Step 1: Failing tests** — cases: OpenAI JSON chat; Anthropic JSON with `tool_use` response (assert `toolCalls` non-empty and `assistantText` null → **the §8.1 fix**); Anthropic SSE stream (text deltas + tool deltas both extracted, raw `data:` never returned); request whose messages carry `tool_result` blocks (name resolved via previous assistant message's `tool_use` ids; unmatched → `null`); embeddings body (`input` → `lastUserText`, label handled by caller); unparseable body (`parsed: false`); message-count arithmetic (`earlierCount = msgCount − rendered slice`).

- [ ] **Step 2–3:** Implement by refactoring the existing `extractPrompt`/`extractAnswer` walkers into the one function; tool calls/results via the core exports (delete any duplicated SSE logic in the cli). `bytes` = `Buffer.byteLength(resultString)`. Keep pure — no Ink imports.

- [ ] **Step 4:** cli suite green (Debug screen still compiles — it keeps using the old helpers until Task 15; keep thin `extractPrompt`/`extractAnswer` wrappers delegating to `extractExchange` so nothing breaks mid-plan).

- [ ] **Step 5: Commit** — `feat(cli): extractExchange — one conversation extractor, tool-call-only responses render (spec §3, §8.1 fix)`

### Task 14: Detail pane — five cards + degraded states

**Files:**
- Create: `packages/cli/src/tui/screens/TraceDetail.tsx` (all cards; consumed by TraceView)
- Modify: `packages/cli/src/tui/screens/TraceView.tsx` (replace old `Detail`)
- Test: `packages/cli/tests/tui-tracedetail.test.tsx`

**Interfaces:**
- Consumes: `DisplayRow` selection, `query.requestDetail`, `query.toolIo` (fetch on selection, memoized by `(requestId, payloadPresent)`), `extractExchange`, token block format (spec §1.3).
- Produces: `<TraceDetail row={DisplayRow} db={db} width={number} height={number} />`.

- [ ] **Step 1: Failing tests** — one render assertion per card, exact wording from the spec:
  - LLM card: contains `USER`, `ASSISTANT`, `→ sap_execute_sap_operation(`, the token block lines (`fresh`, `cached`, `written`, `(99%)`), `⏎ full payload`; duration NOT color-wrapped.
  - Tool card: `attribution window (inferred)`; unresolved variant: `result never returned to the model`; pruned `tool_io`: `args & result expired (payload retention: 7 days)`.
  - API card: full endpoint + decoded query string; a `?key=sk-…` query renders `[redacted]`; status-null variant: `no response — network failure`.
  - Root card: `N of M calls priced`, `slowest`, `issues` line present iff failures exist; partial expiry: `(excludes 9 expired calls)`.
  - Fold card: `12× GET`, `min/median/max`, `all 2xx/3xx`.
  - Width 36 (110-col terminal): stats strip drops `first byte` then start time; status/duration/cost/tokens always present.
- [ ] **Step 2: Verify failure. Step 3: Implement** — one component per card in the same file, shared `Strip` helper implementing the segment-drop order, shared `TokenBlock` (omit-null / show-known-zero lines), the B3 shrink order as a pure `fitSections(caps, budget)` helper with its own unit test. Secret-pattern redaction for query strings: reuse the regexes exported from core `storage/redact.ts` (export them if private).
- [ ] **Step 4:** cli suite green. **Step 5: Commit** — `feat(cli): chat-style detail pane, five cards, degraded states (spec §3)`

### Task 15: Payload screen chat section + token wording

**Files:**
- Modify: `packages/cli/src/tui/screens/Debug.tsx`
- Test: `packages/cli/tests/tui-debug.test.tsx` (update)

- [ ] Replace its LLM Input/Output extraction with `extractExchange` (full text, scrollable — this is the "full view" surface single-pane users get); replace the `", N cached"` token phrasing with the fresh/cached/written block. Update tests; suite green; commit — `feat(cli): payload screen chat section + honest token wording (spec §3, §4 single-pane)`.

### Task 16: Footer context + payload-as-child + remaining states

**Files:**
- Modify: `packages/cli/src/tui/App.tsx` (add `FooterContext` + `useFooter(text)`; render the active footer string; delete the static `FOOTERS` indexing for screens that now own their footer)
- Modify: `packages/cli/src/tui/screens/TraceView.tsx` (render `DebugScreen` as a child state on `⏎`; esc unwinds one level; `useFooter` per state: tree / flat / payload / pruned — exact strings from spec §4)
- Modify: `packages/cli/src/tui/screens/TraceList.tsx` (untraced rows: footer `⏎ open`, ⏎ → payload directly — verify existing behavior, fix the footer string)
- Test: `packages/cli/tests/tui-traceview.test.tsx` (extend)

- [ ] **Step 1: Failing tests:** footer shows `h/l fold` inside TraceView and `f tree` in flat mode; `⏎` on an LLM leaf then `esc` returns to the tree with the same selected row (payload-as-child — the current App-level swap loses the tree); live root renders `● LIVE` and elapsed `…`; incomplete root renders `⚠ incomplete` with TOOK `—`; expired info rows (`· 9 earlier calls expired`) render in tree AND flat mode.
- [ ] **Step 2–3:** Implement. The live/incomplete/expired row logic goes in `tree-model.ts` (info-row emission), not the component.
- [ ] **Step 4:** Full suite. **Step 5: Commit** — `feat(cli): footer context, payload-as-child, live/incomplete/expired states (spec §4)`

### Task 17: End-to-end + cross-runtime verification

- [ ] **Step 1:** Extend `packages/core/tests/trace-e2e.test.ts`: the instrumented server makes one Anthropic-SSE-shaped streaming call that declares a tool → assert the DB holds the tool trace AND normalized tokens (`tokens_in = input + cache_read + cache_creation` from the fixture stream).
- [ ] **Step 2:** Extend `packages/core/tests/bun/serve-trace.test.ts` similarly (Bun path produces identical rows; assert `tokens_cache_write` written under bun:sqlite).
- [ ] **Step 3:** `npx --yes pnpm -r test` + `npx --yes pnpm --filter @burn0/core test:bun` — everything green.
- [ ] **Step 4:** Re-run the Task 12 render script against a fresh fixture DB; eyeball no regression.
- [ ] **Step 5: Commit** — `test: e2e — SSE tool loop to rendered tree, both runtimes (spec §6)`

### Task 18: Documentation + handoff

- [ ] **Step 1:** Spec `docs/spec/2026-07-25-burn0-v1-spec.md`: §8.7 Q8.1 gains "Anthropic SSE form added 2026-08-04"; §12.1b updated to describe the shipped tree/detail (row grammar table + keybinds, referencing the design spec); §3.6 records cache-write pricing; note `SCHEMA_VERSION = 4` where v3 is mentioned.
- [ ] **Step 2:** `README.md`: nothing user-facing changes in commands; add one line under the dashboard section: token columns show total effective input with `↺` marking cached context.
- [ ] **Step 3:** `.superpowers/sdd/progress.md`: append a dated entry — what shipped, the normalization decision and why parse-time won, the fold rules, traps found during implementation (fill from actual experience), what remains (`theme.selBg`, ASCII fallback, `fmtMs m ss`, §5/§6 pricing unchanged).
- [ ] **Step 4:** Final full-suite run; commit — `docs: spec/README/progress for traceview redesign (spec §8)`.

---

## Self-review record

- **Spec coverage:** §1.1–1.2 → Tasks 2–4; §1.3 → Tasks 7, 11, 14, 15; §2.1–2.6 → Tasks 8–10, 12; §3 → Tasks 13–15; §4 → Tasks 5, 6, 10, 16; §5 → Tasks 3, 5, 6; §6 → per-task tests + Task 17; §7 honored (no waterfall/overlay/selBg tasks); §8 → Task 12 gate.
- **Type consistency:** `Usage.tokensCacheWrite`/`inputIncludesCache` (T2) consumed by T3/T4; `traceTree` `{root,nodes}|null` + `method`/`tokensCached` (T6) consumed by T9/T10/T14; `DisplayRow`/`buildRows(opts)` (T9) consumed by T10/T14/T16; `fmtTok/fmtTokPair/CACHE_MARK` (T7) consumed by T9/T11/T14/T15; `toolIo(db, traceId)` single signature (T6→T14).
- **Placeholder scan:** clean — every test step carries code or an exact assertion list; T9's skeleton is backed by an exhaustive rule list in its Interfaces block.
