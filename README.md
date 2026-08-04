# burn0

Local-first, zero-code observability and cost tracking for Node.js apps.
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

## Commands

    burn0            dashboard (terminal UI)
    burn0 today      one-shot summary of today's spend and calls
    burn0 watch      live tail of requests
    burn0 export     dump metadata to JSON/CSV
    burn0 init       write burn0.config.json with defaults

Dev-only tool: auto-disabled when NODE_ENV=production (override with BURN0_FORCE=1).
Data: ~/.burn0/burn0.db (SQLite). Payloads kept 7 days, metadata 30 days. Secrets redacted by default.
