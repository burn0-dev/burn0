# burn0 v1 — build prompt

Paste the block below into a fresh session.

---

Build burn0 v1 end-to-end, to the written spec.

## Where everything is

- **Working directory:** `/Users/srn/Documents/code/burn0-repo/burn0-1`
- **Spec (the source of truth):** `docs/spec/2026-07-25-burn0-v1-spec.md`
- **Handoff log:** `.superpowers/sdd/progress.md` — read the **last** entry
- **Reference only, do not build here:** `/Users/srn/Documents/code/burn0-repo/burn0` (old shipped cloud version, dormant since March)

**Read the spec and the last progress.md entry before writing anything.** Many decisions were settled by evidence — five LLM pricing feeds compared, Node async-context mechanisms tested empirically. Re-deriving them wastes a session. If you disagree with a decision, say so in one sentence and proceed; do not silently re-open it.

## What burn0 is

A local-first CLI for **LLM *and* API observability**. One import (`import 'burn0'`), every outbound call from a Node backend is captured to SQLite at `~/.burn0/burn0.db`, and a terminal UI shows usage, cost and traces. No cloud, no proxy, no signup. Think LangSmith in the terminal, widened to cover the Stripe/Pinecone/S3 calls LangSmith cannot see.

Target user is a **long-running server backend** (Express, Fastify, Koa, Next). Not agent scripts.

## Current state

`pnpm -r test` → **155 passing** (113 core, 42 cli). Keep it green.

Already landed in `packages/core`:
- `entities/index.ts` — `resolveHost()`: vendor/service resolution, service names **derived from subdomain** for multi-service apexes
- `entities/hosts.ts` — `MULTI_SERVICE_APEXES`, `HostRule.vendor`, `sub()` matcher
- `query/index.ts` — `usageRows()` and `usageTree()` (vendor > service > host > endpoint, rollups, single-child collapse)
- `tests/vendors.test.ts`, `tests/usage.test.ts`

`packages/cli` is **untouched** — still the old 4-tab shell.

## Build order

Vertical slices. Each is a thin core change + its screen + tests, green before moving on.

1. **Usage screen** — consume `usageTree` (already built). Replaces the Entities tab. Expand/collapse, in/out columns, no truncation.
2. **Logs tab** — new 5th tab. Unified LLM+API stream, newest first, follow mode (↑ pauses), filters. Needs `traces()` to accept `llm: true | false | null` — today it is a boolean and can never return both. `beforeId` and `liveTail` already exist in core and were never wired to a screen.
3. **Project scoping** — `Scope` type through every query; schema v2 (`projects.key`, `requests.service`). Currently every query is machine-global and `burn0 export` dumps every project.
4. **Traces** — server patch, `runs`/`traces` tables, `trace_id`/`seq`, chronological trace list, two-pane trace view.
5. **Tool calls** — §8. Window-based attribution.

Sections §5/§6 (API pricing, cost engine) are **deferred by the user** — do not build them.

## Non-negotiables

- **TDD.** Write the failing test, watch it fail for the right reason, then minimal code. Do not over-implement in the GREEN step — it produces tests that pass immediately and prove nothing.
- **Never fake a number.** Unpriced renders `—`, never `$0.00`. Unknown bytes render `—`, never `0`. An inferred value is marked as inferred. 70 LiteLLM models carry `$0/$0` and would otherwise display as free.
- **Never hide data.** No top-N, no truncation, no minimum thresholds. A vendor with 2 calls shows 2 calls. Render windows to terminal height; the data is never trimmed.
- **Derive, don't enumerate.** Service names come from the subdomain. Vendor/service are resolved at read time so a rule fix re-buckets existing history with no backfill. Hardcoded lists go stale — this was already caught once.
- **Verify empirically.** Where behaviour is uncertain, write a probe script and run it. "My test passed" is weaker evidence than a maintainer saying the primitive is unsafe — that exact mistake nearly shipped a broken trace mechanism.
- **burn0 must never affect the host app.** Every capture path try/caught; app request proceeds untouched on any internal failure.
- Match existing style: no semicolons, 2-space indent, single quotes, `.js` extensions in imports, vitest, Ink 5.

## Traps already discovered — do not rediscover these

- **`AsyncLocalStorage.enterWith()` is unsafe.** nodejs/node#41978, open since 2022; the async_hooks maintainer says do not use it. `bindStore()` does **not** work on `http.server.request.start` (Node publishes without `runStores`). Correct mechanism: patch `emit` and wrap in `als.run()`. See spec §2.9.
- **Four server classes must be patched, not one.** `https.Server` does *not* inherit from `http.Server`. Patching only `http.Server.prototype.emit` silently misses every HTTPS and HTTP/2 server.
- **SSE responses leak traces.** LLM backends stream; if `finish` never fires the trace sits in the pending map forever. Needs a `close` listener plus a max-age sweep. Unfixed, high severity.
- **Pricing lookup order is backwards.** `pricing/index.ts` tries the bare model name before `provider/model`, so Gemini is billed at 1.5× the correct rate. Provider-qualified must win.
- **`enrich.ts` gates cost on `provider`**, discarding cost for gateway-routed LLM calls even though the bare-name lookup would succeed.
- **Byte counts are wrong on two paths.** `undici-dc.ts` emits `reqBytes: 0, resBytes: 0`; `fetch-patch.ts` uses string `.length`, not `Buffer.byteLength`. Matters once in/out volume is displayed.
- **`entityDetail` groups by endpoint without method**, merging `POST /emails` (costs money) with `GET /emails` (free).

## Working with the user

- They clear context deliberately and rebuild from the spec. **Write conclusions to the spec as you reach them**, not at the end.
- They push back hard on unverified claims and have been right to. Show evidence.
- Explain plainly when asked — no jargon walls. If they say they do not understand, make it *shorter and simpler*, not longer.
- Do not re-litigate settled decisions.

## Definition of done

- `pnpm -r test` green, `pnpm -r build` clean
- `pnpm --filter burn0-test demo` generates traffic; `burn0` renders it correctly across all five tabs
- Spec updated to match what was actually built, including anything that changed during implementation
- New handoff entry appended to `.superpowers/sdd/progress.md`

## One standing item

The repo is **entirely untracked in git** — source, spec and tests exist only as working-tree files. Ask the user whether to commit before making large changes.
