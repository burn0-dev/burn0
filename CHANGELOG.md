# Changelog

## [0.2.7] — 2026-03-28

### Fixed
- **Event loss on startup** — events intercepted before dotenv loads are now buffered and flushed once the API key becomes available (`lateInit` pattern)
- **Failed batch retry** — if a batch shipment fails (network error or non-2xx), events are held in memory and re-sent on the next flush instead of being silently dropped
- **Ledger backfill** — when the SDK connects for the first time with a valid API key, it reads all unsynced events from the local ledger (`.burn0/costs.jsonl`) and ships them to the server, so no historical data is lost

### Added
- `LocalLedger.readUnsynced()` — returns events recorded after the last successful sync
- `LocalLedger.markSynced()` — writes a sync marker to `.burn0/last-sync.txt`
- `syncLedger()` — ships all unsynced ledger events in batches of 500 on connect

---

## [0.2.6] — 2026-03-25

### Added
- Lazy API key detection — burn0 now works when `dotenv` is loaded after the `import '@burn0/burn0'` statement
- `setTimeout(0)` settle pattern to wait for the event loop before re-checking for the API key

---

## [0.2.5] — 2026-03-20

### Added
- Local ledger (`costs.jsonl`) for persistent event storage and offline cost tracking
- `burn0 report` CLI command — shows cost breakdown from local ledger
- Local pricing cache — estimates costs offline using cached pricing data
- Ticker output on process exit — prints today's spend summary per service

### Fixed
- HTTP module patching (`node:http` / `node:https`) for non-fetch based SDKs

---

## [0.2.0] — 2026-03-10

### Added
- `burn0 init` CLI — interactive setup wizard, detects installed SDKs, writes config
- `burn0 dev` — live cost ticker in terminal during development
- Multi-mode operation: `dev-local`, `dev-cloud`, `prod-local`, `prod-cloud`, `test-disabled`
- Import order guard — warns if SDKs are imported before burn0

---

## [0.1.0] — 2026-03-01

### Added
- Initial release
- fetch and http/https interception
- Service detection for 30+ providers (OpenAI, Anthropic, Stripe, Resend, etc.)
- Token + cost tracking for LLM responses
- `track()` and `startSpan()` manual tracking API
- `restore()` to unpatch interceptors
