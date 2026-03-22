# Setup Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slow multi-step init wizard with a fast 3-step postinstall flow: API key → auto-detect services → done.

**Architecture:** Extract shared API key logic into `src/cli/api-key.ts`, rewrite `src/cli/init.ts` as a lean wizard, rewrite `scripts/postinstall.js` to spawn the wizard on install, and update `src/index.ts` to skip patching in `prod-local` mode.

**Tech Stack:** TypeScript, @inquirer/prompts, chalk, commander, vitest

**Spec:** `docs/superpowers/specs/2026-03-22-setup-flow-redesign.md`

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/cli/api-key.ts` | Create | Shared API key prompt + validation + write-to-env |
| `src/cli/init.ts` | Rewrite | New 3-step wizard (API key → services → done) |
| `src/cli/connect.ts` | Rewrite | Alias that calls shared API key function |
| `scripts/postinstall.js` | Rewrite | TTY-gated wizard trigger via execFileSync |
| `src/index.ts` | Modify | Add prod-local guard to skip patching + warn |
| `tests/cli/init.test.ts` | Keep | Existing test still valid (tests detectServices) |

---

### Task 1: Extract shared API key logic into `src/cli/api-key.ts`

**Files:**
- Create: `src/cli/api-key.ts`
- Modify: `src/cli/connect.ts`

- [ ] **Step 1: Create `src/cli/api-key.ts`**

Extract the API key prompt, validation, and env-writing into a shared module that both init and connect can use.

```typescript
import { input, select } from '@inquirer/prompts'
import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function openBrowser(url: string): boolean {
  try {
    const platform = process.platform
    if (platform === 'darwin') execFileSync('open', [url])
    else if (platform === 'win32') execFileSync('cmd', ['/c', 'start', url])
    else execFileSync('xdg-open', [url])
    return true
  } catch {
    return false
  }
}

export async function promptApiKey(cwd: string): Promise<string | undefined> {
  const choice = await select({
    message: 'API key?',
    choices: [
      { name: 'Paste key', value: 'paste' },
      { name: 'Get one free → burn0.dev/api', value: 'get' },
      { name: 'Skip — local mode', value: 'skip' },
    ],
  })

  if (choice === 'skip') return undefined

  if (choice === 'get') {
    const opened = openBrowser('https://burn0.dev/api')
    if (!opened) {
      console.log(chalk.dim('\n  Visit burn0.dev/api to get your free API key\n'))
    } else {
      console.log(chalk.dim('\n  Opening burn0.dev/api in your browser...\n'))
    }
  }

  // Retry loop for key validation
  while (true) {
    const apiKey = await input({ message: 'Paste your API key:' })

    if (!apiKey || !apiKey.startsWith('b0_sk_')) {
      console.log(chalk.red('\n  Invalid key. Keys start with b0_sk_'))
      const retry = await select({
        message: 'What would you like to do?',
        choices: [
          { name: 'Try again', value: 'retry' },
          { name: 'Skip — local mode', value: 'skip' },
        ],
      })
      if (retry === 'skip') return undefined
      continue
    }

    writeApiKeyToEnv(cwd, apiKey)
    console.log(chalk.green('  ✓ Added BURN0_API_KEY to .env'))
    return apiKey
  }
}

export function writeApiKeyToEnv(cwd: string, apiKey: string): void {
  const envPath = path.join(cwd, '.env')
  const examplePath = path.join(cwd, '.env.example')

  let envContent = ''
  try { envContent = fs.readFileSync(envPath, 'utf-8') } catch {}

  if (envContent.includes('BURN0_API_KEY=')) {
    envContent = envContent.replace(/BURN0_API_KEY=.*/, `BURN0_API_KEY=${apiKey}`)
  } else {
    envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}BURN0_API_KEY=${apiKey}\n`
  }
  fs.writeFileSync(envPath, envContent)

  let exampleContent = ''
  try { exampleContent = fs.readFileSync(examplePath, 'utf-8') } catch {}
  if (!exampleContent.includes('BURN0_API_KEY=')) {
    exampleContent += `${exampleContent && !exampleContent.endsWith('\n') ? '\n' : ''}BURN0_API_KEY=\n`
    fs.writeFileSync(examplePath, exampleContent)
  }
}
```

- [ ] **Step 2: Rewrite `src/cli/connect.ts` to use shared module**

```typescript
import { promptApiKey } from './api-key'

export async function runConnect(): Promise<void> {
  await promptApiKey(process.cwd())
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests PASS (connect tests may need updating if they tested the old flow)

- [ ] **Step 4: Commit**

```bash
git add src/cli/api-key.ts src/cli/connect.ts
git commit -m "refactor: extract shared API key logic into api-key.ts"
```

---

### Task 2: Rewrite `src/cli/init.ts` — new 3-step wizard

**Files:**
- Rewrite: `src/cli/init.ts`

- [ ] **Step 1: Replace `src/cli/init.ts` with the new wizard**

```typescript
import { select, checkbox, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { detectServices } from '../services/detect'
import { scanCodebase } from '../services/scan'
import { writeConfig } from '../config/store'
import { SERVICE_CATALOG } from '../services/catalog'
import { promptApiKey } from './api-key'

export async function runInit(): Promise<void> {
  try {
    await _runInit()
  } catch (err: any) {
    if (err.name === 'ExitPromptError' || err.message?.includes('SIGINT')) {
      console.log('\n\n  Cancelled. Run `npx burn0 init` when ready.\n')
      process.exit(0)
    }
    throw err
  }
}

async function _runInit(): Promise<void> {
  const cwd = process.cwd()

  console.log(chalk.dim('\n  burn0 — track every API cost\n'))

  // Step 1: API key
  const apiKey = await promptApiKey(cwd)

  // Step 2: Auto-detect + confirm services
  console.log(chalk.dim('\n  Scanning your project...\n'))

  const pkgServices = detectServices(cwd)
  const scannedServices = scanCodebase(cwd)
  const detectedNames = new Set(pkgServices.map(s => s.name))
  const newFromScan = scannedServices.filter(s => !detectedNames.has(s.name))

  // Build unified list of detected services
  const allDetected: { name: string; displayName: string; autopriced: boolean }[] = []

  for (const svc of pkgServices) {
    const entry = SERVICE_CATALOG.find(c => c.name === svc.name)
    allDetected.push({
      name: svc.name,
      displayName: entry?.displayName ?? svc.name,
      autopriced: svc.autopriced,
    })
  }
  for (const svc of newFromScan) {
    const entry = SERVICE_CATALOG.find(c => c.name === svc.name)
    allDetected.push({
      name: svc.name,
      displayName: entry?.displayName ?? svc.name,
      autopriced: entry?.pricingType !== 'fixed',
    })
  }

  let selectedServices: string[] = []

  if (allDetected.length > 0) {
    const ADD_MORE = '__add_more__'

    const choices = allDetected.map(svc => ({
      name: `${svc.displayName.padEnd(20)} ${svc.autopriced ? chalk.dim('auto-priced') : chalk.yellow('select plan ▸')}`,
      value: svc.name,
      checked: true,
    }))
    choices.push({ name: chalk.cyan('+ Add more services...'), value: ADD_MORE, checked: false })

    selectedServices = await checkbox({
      message: 'Detected services (uncheck to exclude):',
      choices,
    })

    // Handle "Add more" selection
    if (selectedServices.includes(ADD_MORE)) {
      selectedServices = selectedServices.filter(s => s !== ADD_MORE)
      const additionalServices = SERVICE_CATALOG.filter(s =>
        !allDetected.some(d => d.name === s.name)
      )

      if (additionalServices.length > 0) {
        const llmChoices = additionalServices
          .filter(s => s.category === 'llm')
          .map(s => ({ name: s.displayName, value: s.name }))
        const apiChoices = additionalServices
          .filter(s => s.category === 'api')
          .map(s => ({ name: s.displayName, value: s.name }))
        const infraChoices = additionalServices
          .filter(s => s.category === 'infra')
          .map(s => ({ name: s.displayName, value: s.name }))

        const additional = await checkbox({
          message: 'Select additional services:',
          choices: [
            ...(llmChoices.length ? [{ name: chalk.bold.blue('── LLM Providers ──'), value: '__sep', disabled: true as any }] : []),
            ...llmChoices,
            ...(apiChoices.length ? [{ name: chalk.bold.magenta('── API Services ──'), value: '__sep2', disabled: true as any }] : []),
            ...apiChoices,
            ...(infraChoices.length ? [{ name: chalk.bold.yellow('── Infrastructure ──'), value: '__sep3', disabled: true as any }] : []),
            ...infraChoices,
          ],
        })
        selectedServices.push(...additional.filter(s => !s.startsWith('__sep')))
      }
    }
  } else {
    console.log(chalk.dim('  No services detected.\n'))
    // Go straight to catalog
    const llmChoices = SERVICE_CATALOG
      .filter(s => s.category === 'llm')
      .map(s => ({ name: s.displayName, value: s.name }))
    const apiChoices = SERVICE_CATALOG
      .filter(s => s.category === 'api')
      .map(s => ({ name: s.displayName, value: s.name }))
    const infraChoices = SERVICE_CATALOG
      .filter(s => s.category === 'infra')
      .map(s => ({ name: s.displayName, value: s.name }))

    selectedServices = await checkbox({
      message: 'Select the services you use:',
      choices: [
        ...(llmChoices.length ? [{ name: chalk.bold.blue('── LLM Providers ──'), value: '__sep', disabled: true as any }] : []),
        ...llmChoices,
        ...(apiChoices.length ? [{ name: chalk.bold.magenta('── API Services ──'), value: '__sep2', disabled: true as any }] : []),
        ...apiChoices,
        ...(infraChoices.length ? [{ name: chalk.bold.yellow('── Infrastructure ──'), value: '__sep3', disabled: true as any }] : []),
        ...infraChoices,
      ],
    })
    selectedServices = selectedServices.filter(s => !s.startsWith('__sep'))
  }

  // Prompt for fixed-tier service plans
  const serviceConfigs: { name: string; plan?: string; monthlyCost?: number }[] = []

  for (const name of selectedServices) {
    const entry = SERVICE_CATALOG.find(c => c.name === name)
    if (entry?.pricingType === 'fixed' && entry.plans) {
      const plan = await select({
        message: `${entry.displayName} — which plan?`,
        choices: [
          ...entry.plans.map(p => ({ name: p.name, value: p.value })),
          { name: 'Skip', value: 'skip' },
        ],
      })
      if (plan !== 'skip') {
        const selected = entry.plans.find(p => p.value === plan)
        serviceConfigs.push({ name, plan, monthlyCost: selected?.monthly })
      } else {
        serviceConfigs.push({ name })
      }
    } else {
      serviceConfigs.push({ name })
    }
  }

  // Read project name from package.json
  let projectName = 'my-project'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'))
    if (pkg.name) projectName = pkg.name
  } catch {}

  // Write config
  writeConfig(cwd, {
    projectName,
    services: serviceConfigs.map(s => ({
      name: s.name,
      pricingModel: s.plan ? 'fixed-tier' as const : 'auto' as const,
      plan: s.plan,
      monthlyCost: s.monthlyCost,
    })),
  })

  // Ensure .burn0/ in gitignore
  ensureGitignore(cwd, '.burn0/')

  // Check .env in gitignore
  const gitignorePath = path.join(cwd, '.gitignore')
  let gitignoreContent = ''
  try { gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8') } catch {}
  if (!gitignoreContent.includes('.env')) {
    const addEnv = await confirm({ message: '.env is not in .gitignore. Add it?' })
    if (addEnv) ensureGitignore(cwd, '.env')
  }

  // Step 3: Done
  console.log('')
  console.log(chalk.green('  ✓ Setup complete'))
  console.log('')
  console.log(chalk.dim('  Add this to your entry file:'))
  console.log(chalk.white("    import '@burn0/burn0'"))
  console.log('')
  console.log(chalk.dim('  Then run your app to see costs.'))
  console.log('')
}

function ensureGitignore(cwd: string, entry: string): void {
  const gitignorePath = path.join(cwd, '.gitignore')
  let content = ''
  try { content = fs.readFileSync(gitignorePath, 'utf-8') } catch {}
  if (!content.includes(entry)) {
    content += `${content && !content.endsWith('\n') ? '\n' : ''}${entry}\n`
    fs.writeFileSync(gitignorePath, content)
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Manually test the wizard**

Run: `npx tsx src/cli/index.ts init`
Expected: See the new 3-step wizard flow (API key → services → done)

- [ ] **Step 4: Commit**

```bash
git add src/cli/init.ts
git commit -m "feat: rewrite init as fast 3-step wizard"
```

---

### Task 3: Rewrite `scripts/postinstall.js`

**Files:**
- Rewrite: `scripts/postinstall.js`

- [ ] **Step 1: Replace `scripts/postinstall.js`**

```javascript
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

- [ ] **Step 2: Test postinstall locally**

Run: `npm run build && node scripts/postinstall.js`
Expected: The init wizard launches (since you're in a TTY)

- [ ] **Step 3: Commit**

```bash
git add scripts/postinstall.js
git commit -m "feat: postinstall triggers init wizard in TTY"
```

---

### Task 4: Add prod-local guard to `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the prod-local warning and skip patching**

In `src/index.ts`, make three changes:

**Change 1:** Guard `fetchPricing` to exclude `prod-local` (line 26). Find:
```typescript
if (mode !== 'test-disabled') {
  fetchPricing(BURN0_API_URL, originalFetch).catch(() => {})
}
```
Replace with:
```typescript
if (mode !== 'test-disabled' && mode !== 'prod-local') {
  fetchPricing(BURN0_API_URL, originalFetch).catch(() => {})
}
```

**Change 2:** Add prod-local warning and guard patching. Find the patch guard block (line 87):
```typescript
if (canPatch() && mode !== 'test-disabled') {
```
Add the warning before it and update the guard:
```typescript
if (mode === 'prod-local') {
  console.warn('[burn0] No API key — costs not tracked. Get one free at burn0.dev/api')
}

if (canPatch() && mode !== 'test-disabled' && mode !== 'prod-local') {
```

**Change 3:** Update the import-order warning (line 84) to use the new package name:
```typescript
  console.warn(`[burn0] Warning: These SDKs were imported before burn0 and may not be tracked: ${preloaded.join(', ')}. Move \`import '@burn0/burn0'\` to the top of your entry file.`)
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: skip patching in prod-local, warn about missing API key"
```

---

### Task 5: Final integration — build, test, lint

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No type errors

- [ ] **Step 4: Test the full postinstall flow**

Run: `npm run build && node scripts/postinstall.js`
Expected: Wizard runs, creates `.burn0/config.json`, shows completion message

- [ ] **Step 5: Test non-TTY postinstall**

Run: `npm run build && node scripts/postinstall.js | cat`
Expected: Prints `[burn0] Run "npx burn0 init" to set up cost tracking.` (piping to `cat` makes stdout non-TTY)

- [ ] **Step 6: Fix any issues and commit**

```bash
git add -A
git commit -m "fix: resolve integration issues from setup flow redesign"
```
