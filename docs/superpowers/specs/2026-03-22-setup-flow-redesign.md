# Setup Flow Redesign — Design Spec

## Problem

The current `burn0 init` wizard is too long (17-line ASCII banner, 4-5 interactive prompts, service catalog checkbox with 50 items). It takes minutes instead of seconds. The postinstall message just says "run burn0 init" — a dead-end most users ignore. The result: most users never complete setup.

## Solution

Replace the init wizard with a fast 3-step flow that runs automatically during `npm i` (when in an interactive terminal). API key first, auto-detect services, done.

## Trigger

- **Primary:** Postinstall hook after `npm i @burn0/burn0`
- **Fallback:** `npx burn0 init` for manual runs or re-configuration
- **TTY gate:** Only runs when `process.stdout.isTTY` is true (consistent with the existing `isTTY()` check in `src/config/env.ts`). In CI/Docker/scripts, prints a single line: `[burn0] Run "npx burn0 init" to set up cost tracking.` and exits.
- **Re-run safe:** If `.burn0/config.json` already exists, postinstall skips the wizard and prints: `[burn0] Already configured. Run "npx burn0 init" to reconfigure.`

## Postinstall Invocation

The postinstall script (`scripts/postinstall.js`) spawns the compiled CLI with the `init` subcommand. This works because the `dist/` directory is included in the published package (`"files": ["dist", "scripts"]` in package.json). The postinstall script does NOT use `npx burn0 init` because bin links are not yet set up during postinstall.

```javascript
// scripts/postinstall.js
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const projectRoot = process.env.INIT_CWD || process.cwd()

if (!process.stdout.isTTY) {
  console.log('[burn0] Run "npx burn0 init" to set up cost tracking.')
  process.exit(0)
}
try {
  const configPath = path.join(projectRoot, '.burn0', 'config.json')
  if (fs.existsSync(configPath)) {
    console.log('[burn0] Already configured. Run "npx burn0 init" to reconfigure.')
    process.exit(0)
  }
} catch {}
// Spawn the compiled CLI with init subcommand
// __dirname is scripts/, so the CLI is at ../dist/cli/index.js
try {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli', 'index.js')
  execFileSync('node', [cliPath, 'init'], {
    stdio: 'inherit',
    cwd: projectRoot,
  })
} catch {
  console.log('[burn0] Setup skipped. Run "npx burn0 init" when ready.')
}
```

Key details:
- Uses `execFileSync` (not `execSync`) to avoid shell injection risks.
- Uses `process.env.INIT_CWD` (set by npm to the directory where `npm install` was run) for the project root. Falls back to `process.cwd()`.
- Uses `__dirname` (not `process.cwd()`) to resolve the path to the compiled CLI, since path resolution must be relative to the file's location.
- Spawns as a child process with `stdio: 'inherit'` so the interactive prompts work.
- The CLI entry is `dist/cli/index.js` (the single bundled file produced by tsup), not a separate init entry point. Commander routes the `init` argument to the init handler.

## Wizard Flow

### Step 1 — API key

```
  burn0 — track every API cost

  API key?
    ○ Paste key
    ○ Get one free → burn0.dev/api
    ○ Skip — local mode
```

- "Paste key" → prompts for key, validates format (must start with `b0_sk_`), writes to `.env` as `BURN0_API_KEY=<key>`
- "Get one free" → opens `burn0.dev/api` in the user's default browser (using `open` on macOS, `xdg-open` on Linux, `start` on Windows), then re-prompts for the key paste. If browser open fails, prints the URL to the terminal instead.
- "Skip" → continues without a key, local-only mode

### Step 2 — Auto-detect + confirm services

```
  Detected services:
    ✓ openai          auto-priced
    ✓ stripe          auto-priced
    ✓ supabase        select plan ▸
    ✓ vercel          select plan ▸

  + Add more services...
```

- Scans `package.json` dependencies using existing `detectServices()` function
- Scans codebase for API hostnames/env vars using existing `scanCodebase()` function
- Results shown as a checkbox list using `@inquirer/prompts` `checkbox()` — all detected services pre-checked
- User can uncheck to exclude services from config. **Note:** unchecking a service removes it from `.burn0/config.json` but does NOT prevent burn0 from intercepting its API calls at runtime. Runtime interception is hostname-based and always active. The config is for cost reporting and dashboard purposes only.
- After the checkbox confirms, fixed-tier services are prompted sequentially with `select()` for plan selection (same as current flow but only for services the user kept checked). This is the "select plan ▸" flow — it's a sequential prompt per fixed-tier service, not an inline sub-menu.
- `+ Add more services...` is a choice at the bottom of the checkbox list. If selected, opens a second `checkbox()` with the full `SERVICE_CATALOG` grouped by category (LLM / API / Infrastructure), excluding already-detected services.
- All selected services (auto-priced and fixed-tier with plans) are written to `.burn0/config.json`.
- **If API key was given:** selections sync to backend DB. Backend sync endpoint is out of scope for this spec — to be designed separately. For now, config is stored locally even with an API key. Sync will be wired in when the endpoint exists.
- **If no API key:** selections stored only in `.burn0/config.json`

### Step 3 — Done

```
  ✓ Setup complete

  Add this to your entry file:
    import '@burn0/burn0'

  Then run your app to see costs.
```

Three lines. No box drawing. No multi-step instructions.

Note on import path: the package is published as `@burn0/burn0`, so the import is `import '@burn0/burn0'`. All existing references in the codebase (postinstall message, init next-steps, import-order warning) should be updated to use `@burn0/burn0`.

## What Gets Written Locally

- `.burn0/config.json` — project name (auto-read from `package.json` name), all selected services (auto-priced and fixed-tier), plan selections for fixed-tier services
- `.env` — `BURN0_API_KEY=<key>` (only if provided). Also adds to `.env.example` as `BURN0_API_KEY=`
- `.gitignore` — adds `.burn0/` if missing. Prompts to add `.env` if not already in `.gitignore`

## What Gets Synced (API Key Users Only)

- On setup: backend sync is **deferred** — out of scope for this spec. Config is stored locally for now.
- On runtime: events → backend via existing batch mechanism (already works)
- Backend sync of project config will be designed as a separate spec when the endpoint is built.

## Anonymous (No API Key) Behavior

- Everything local: config in `.burn0/config.json`, events in `.burn0/costs.jsonl`
- Ticker works in terminal (if TTY)
- `burn0 report` works from local ledger data
- Zero backend contact — burn0 makes no network calls to burn0.dev

## Production Without API Key

When burn0 detects no API key and no TTY (i.e., `prod-local` mode):
- Logs a single warning via `console.warn`: `[burn0] No API key — costs not tracked. Get one free at burn0.dev/api`
- Skips HTTP/fetch patching entirely — zero runtime overhead
- This is a **new behavior change**: currently `prod-local` mode still patches HTTP/fetch and accumulates events in memory. The new behavior skips patching entirely.
- Implementation: in `src/index.ts`, change the patch guard from `canPatch() && mode !== 'test-disabled'` to `canPatch() && mode !== 'test-disabled' && mode !== 'prod-local'`
- The warning prints once per process (on module load). No flag needed — it runs at import time which is once per process.

## What Gets Removed From Current Init

| Current | New |
|---|---|
| 17-line ASCII art banner | Single line: `burn0 — track every API cost` |
| Project name prompt | Auto-read from `package.json` name |
| "Do you have a burn0 API key?" with 2 options | 3 options including "Get one free" with browser open |
| "Do you use other paid APIs?" confirm → full catalog checkbox | `+ Add more services...` inline option |
| 10-line next-steps box with borders | 3 clean lines |
| Separate `burn0 connect` command | Absorbed into init Step 1 |

## Files to Change

### `src/cli/init.ts` — Rewrite
- Remove ASCII banner
- Reorder: API key first, then service detection
- API key validation: must start with `b0_sk_` (carried from `connect.ts`)
- Service display as checkbox list with all detected pre-checked
- Fixed-tier plan selection as sequential `select()` prompts after checkbox confirms
- `+ Add more services...` as a checkbox item that triggers second catalog selection
- All selected services (auto-priced + fixed-tier) written to config
- Remove project name prompt (auto-read from package.json)
- Add browser-open for "Get one free" option (with fallback to print URL)
- Simplify completion message to 3 lines
- Update import path references to `@burn0/burn0`

### `scripts/postinstall.js` — Rewrite
- Add `stdout.isTTY` check
- Add config-exists check (skip if `.burn0/config.json` exists)
- Spawn compiled CLI via `execFileSync('node', [cliPath, 'init'])` using `__dirname`-based path to `../dist/cli/index.js`
- Non-TTY: print single-line "run npx burn0 init" message
- Update import path reference to `@burn0/burn0`

### `src/cli/connect.ts` — Keep as alias
- Keep `burn0 connect` as a command
- Implementation: just run the API key step from init (extract the API key prompt into a shared function both init and connect can call)
- No deprecation warning needed — it's a convenience alias

### `src/index.ts` — Add prod-local guard
- Change patch guard: add `&& mode !== 'prod-local'` to skip patching when no API key and no TTY
- Add `console.warn` for the no-API-key warning in `prod-local` mode
- Remove the existing `prod-local` `beforeExit` handler (already removed by the ticker refactor)

### `src/cli/index.ts` — Update
- Keep `connect` command (alias behavior)

## Edge Cases

- **No package.json found:** skip auto-detect, go straight to manual service selection via catalog
- **Postinstall in monorepo:** `process.cwd()` may be the package dir, not the project root. Use `process.env.INIT_CWD` (set by npm during install to the directory where `npm install` was run) to find the actual project root. Fall back to `process.cwd()` if not set.
- **User Ctrl+C during wizard:** catch `ExitPromptError` (already handled), print "Cancelled. Run `npx burn0 init` when ready."
- **API key validation fails:** show error "Invalid key. Keys start with b0_sk_", let user retry or skip
- **Browser open fails:** fall back to printing the URL in the terminal: `Visit burn0.dev/api to get your free API key`
- **`.env` file doesn't exist:** create it with just `BURN0_API_KEY=<key>`
- **`.env` already has `BURN0_API_KEY`:** replace the existing value (same as current `writeApiKeyToEnv` behavior)
- **Re-running `burn0 init` with existing config:** overwrite config with new selections (user explicitly chose to re-run)
- **Zero services detected:** show message "No services detected" and go straight to `+ Add more services...` catalog
- **Concurrent postinstall in monorepo workspaces:** `.env` write uses `process.env.INIT_CWD` for the project root. Concurrent writes to different workspace `.env` files are safe. If multiple packages write to the same root `.env`, last write wins — acceptable since they'd all write the same key.
