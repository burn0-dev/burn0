# burn0

Local-first, zero-code observability and cost tracking for Node.js and Bun apps.
One import — every outbound API call tracked, LLM costs computed, data stays on your machine.

Think of it as a local Sentry/Datadog for your backend's LLM & API usage — no cloud, no signup,
no proxy. Not a coding-agent tracker (codeburn) and not a proxy (burnlens): burn0 tracks your
*application's* API traffic in-process.

## Quick start

    npm install burn0
    # top of your entry file:
    import 'burn0'
    # run your app, then:
    npx burn0

## Bun

No code changes either — preload the register module when starting your app:

    bun --import burn0/register src/index.ts

Works with `--watch`/`--hot`, and with Hono in both shapes — `export default app`
and explicit `Bun.serve({ fetch: app.fetch })`. Each inbound request auto-roots a
trace; the LLM and API calls made inside the handler land under it in order.
Storage uses `bun:sqlite` writing the same database file the Node CLI reads, so
`burn0` / `burn0 today` work unchanged against a Bun-generated database.

Streaming chat routes trace correctly: a handler that returns an SSE `Response`
immediately and then runs its agent loop inside the stream keeps one trace open
until the stream ends, with every LLM/API call under it.

Bun-specific limits: outbound capture is `fetch`-based (calls made through
`node:http` under Bun are not captured, and servers built on Bun's `node:http`
compat get no automatic trace roots — `Bun.serve` is the supported primitive).

## Commands

    burn0            dashboard (terminal UI)
    burn0 today      one-shot summary of today's spend and calls
    burn0 watch      live tail of requests
    burn0 export     dump metadata to JSON/CSV
    burn0 init       write burn0.config.json with defaults

Dev-only tool: auto-disabled when NODE_ENV=production (override with BURN0_FORCE=1).
Data: ~/.burn0/burn0.db (SQLite). Payloads kept 7 days, metadata 30 days. Secrets redacted by default.
