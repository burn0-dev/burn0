# Live Event Feed + Monthly Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live SSE event feed to the dashboard and monthly cost projections to the dashboard, CLI ticker, and CLI report.

**Architecture:** Server gets an EventEmitter singleton, SSE endpoint, and projection field on `/v1/report`. App gets an SSE proxy and event feed page. SDK gets projection in ticker and report. Stashed partial implementations exist in both server and app repos — pop stash first, then modify.

**Tech Stack:** Express (server), Next.js 16 (app), TypeScript, SSE/EventSource, MongoDB

**Spec:** `docs/superpowers/specs/2026-03-23-events-feed-projections.md`

**IMPORTANT:** The server repo is at `/Users/srn/Documents/code/burn0-repo/burn0-server`. The app repo is at `/Users/srn/Documents/code/burn0-repo/burn0-app`. The SDK repo is at `/Users/srn/Documents/code/burn0-repo/burn0`. Each task specifies which repo to work in. Before starting any server or app task, run `git stash pop` to restore the stashed partial work.

---

### File Map

**Server (`burn0-server`):**

| File | Action | Responsibility |
|---|---|---|
| `src/worker/emitter.ts` | Create | Shared EventEmitter singleton |
| `src/routes/events-list.ts` | Modify (stashed) | REST list + SSE stream endpoints |
| `src/worker/processor.ts` | Modify | Emit processed events via emitter |
| `src/index.ts` | Modify (stashed) | Register events-list route |
| `src/db.ts` | Modify | Add compound index |
| `src/routes/report.ts` | Modify | Add `projection_monthly` field |

**App (`burn0-app`):**

| File | Action | Responsibility |
|---|---|---|
| `src/app/api/dashboard/events/stream/route.ts` | Create | SSE proxy via ReadableStream |
| `src/app/dashboard/events/page.tsx` | Modify (stashed) | Replace polling with SSE |
| `src/app/api/dashboard/events/route.ts` | Verify (stashed) | REST proxy exists |
| `src/app/dashboard/sidebar-nav.tsx` | Modify (stashed) | Add Events nav item |
| `src/app/dashboard/cost-dashboard.tsx` | Modify | Add monthly projection stat card |

**SDK (`burn0`):**

| File | Action | Responsibility |
|---|---|---|
| `src/transport/logger.ts` | Modify | Add projection to exit summary |
| `src/cli/report.ts` | Modify | Add projection line at bottom |

---

### Task 1: Server — EventEmitter + register REST endpoint + DB index

**Repo:** `burn0-server` (`/Users/srn/Documents/code/burn0-repo/burn0-server`)

**Files:**
- Create: `src/worker/emitter.ts`
- Modify: `src/index.ts`
- Modify: `src/db.ts`

- [ ] **Step 1: Pop stash to restore partial work**

```bash
cd /Users/srn/Documents/code/burn0-repo/burn0-server
git stash pop
```

This restores `src/routes/events-list.ts` (REST endpoint) and the import in `src/index.ts`.

- [ ] **Step 2: Create `src/worker/emitter.ts`**

```typescript
import { EventEmitter } from 'node:events'

const emitter = new EventEmitter()
emitter.setMaxListeners(100)

export default emitter
```

- [ ] **Step 3: Register events-list route in `src/index.ts`**

The stash should have restored `import eventsListRouter from './routes/events-list'` and `app.use(eventsListRouter)`. Verify these are present. If not, add:

```typescript
import eventsListRouter from './routes/events-list'
```

And in routes section:
```typescript
  app.use(eventsListRouter)
```

- [ ] **Step 4: Add compound index to `src/db.ts`**

Add after the existing indexes in `connectDb()`:

```typescript
  await db.collection('events').createIndex({ project_name: 1, status: 1, timestamp: -1 })
```

- [ ] **Step 5: Verify server starts**

```bash
npm run dev
```

Test the REST endpoint:
```bash
curl -s "http://localhost:7001/v1/dashboard/events?userId=YOUR_USER_ID" \
  -H "X-Internal-Secret: YOUR_SECRET" | head -c 200
```

- [ ] **Step 6: Commit**

```bash
git add src/worker/emitter.ts src/routes/events-list.ts src/index.ts src/db.ts
git commit -m "feat: add event emitter, register events-list route, add DB index"
```

---

### Task 2: Server — Worker emits events + SSE endpoint + projection on report

**Repo:** `burn0-server`

**Files:**
- Modify: `src/worker/processor.ts`
- Modify: `src/routes/events-list.ts`
- Modify: `src/routes/report.ts`

- [ ] **Step 1: Modify worker to emit processed events**

In `src/worker/processor.ts`, add import at top:

```typescript
import emitter from './emitter'
```

In the `runWorkerCycle` function, after `bulkWrite` succeeds (after line 64), add:

```typescript
  // Emit processed events for SSE listeners
  for (const event of pendingEvents) {
    const result = processEvent(event as any)
    emitter.emit('event:processed', {
      _id: event._id,
      service: event.service,
      endpoint: event.endpoint,
      model: event.model,
      method: event.method,
      tokens_in: event.tokens_in,
      tokens_out: event.tokens_out,
      status_code: event.status_code,
      duration_ms: event.duration_ms,
      cost: result.cost,
      cost_breakdown: result.cost_breakdown,
      timestamp: event.timestamp,
      project_name: event.project_name,
      feature: event.feature,
      metadata: event.metadata,
      estimated: event.estimated,
    })
  }
```

- [ ] **Step 2: Add SSE endpoint to `src/routes/events-list.ts`**

Add at the bottom of the file, before `export default router`:

```typescript
import emitter from '../worker/emitter'

// SSE stream — pushes new events in real-time
router.get('/v1/dashboard/events/stream', requireInternalSecret, async (req, res) => {
  const userId = req.query.userId as string
  if (!userId) {
    res.status(400).json({ error: 'userId is required' })
    return
  }

  const db = getDb()
  const userKeys = await db.collection('api_keys')
    .find({ userId, active: true })
    .toArray()

  const projectNames = new Set(userKeys.map(k => k.project_name))

  if (projectNames.size === 0) {
    res.status(200).end()
    return
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n')
  }, 30000)

  // Listen for processed events
  const handler = (event: any) => {
    if (projectNames.has(event.project_name)) {
      const data = {
        id: event._id?.toString(),
        service: event.service,
        endpoint: event.endpoint,
        model: event.model,
        method: event.method,
        tokens_in: event.tokens_in,
        tokens_out: event.tokens_out,
        status_code: event.status_code,
        duration_ms: event.duration_ms,
        cost: event.cost,
        cost_breakdown: event.cost_breakdown,
        timestamp: event.timestamp,
        project_name: event.project_name,
        feature: event.feature,
        metadata: event.metadata,
        estimated: event.estimated,
      }
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
  }

  emitter.on('event:processed', handler)

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat)
    emitter.removeListener('event:processed', handler)
  })
})
```

Make sure the `emitter` import is at the top of the file alongside other imports.

- [ ] **Step 3: Add `projection_monthly` to `/v1/report`**

In `src/routes/report.ts`, in the existing `/v1/report` handler, before `res.json(...)`, add:

```typescript
    const projectionMonthly = days > 0 && totalCost > 0
      ? Math.round((totalCost / days) * 30 * 1_000_000) / 1_000_000
      : 0
```

Then add `projection_monthly: projectionMonthly` to the response object.

- [ ] **Step 4: Test SSE**

Start server, then in another terminal:

```bash
curl -N "http://localhost:7001/v1/dashboard/events/stream?userId=YOUR_USER_ID" \
  -H "X-Internal-Secret: YOUR_SECRET"
```

This should hang (waiting for events). Send a test event from another terminal and see if it appears in the SSE stream.

- [ ] **Step 5: Commit**

```bash
git add src/worker/processor.ts src/routes/events-list.ts src/routes/report.ts
git commit -m "feat: SSE event stream, worker emits processed events, projection on report"
```

---

### Task 3: App — SSE proxy route

**Repo:** `burn0-app` (`/Users/srn/Documents/code/burn0-repo/burn0-app`)

**Files:**
- Create: `src/app/api/dashboard/events/stream/route.ts`

- [ ] **Step 1: Pop stash to restore partial work**

```bash
cd /Users/srn/Documents/code/burn0-repo/burn0-app
git stash pop
```

This restores the events page, REST proxy, sidebar changes, and cost-dashboard changes.

- [ ] **Step 2: Create SSE proxy**

Create `src/app/api/dashboard/events/stream/route.ts`:

```typescript
import { auth } from '@/lib/auth'

const BURN0_SERVER_URL = process.env.BURN0_SERVER_URL ?? 'http://localhost:7001'
const BURN0_INTERNAL_SECRET = process.env.BURN0_INTERNAL_SECRET ?? ''

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const serverUrl = `${BURN0_SERVER_URL}/v1/dashboard/events/stream?userId=${session.user.id}`

  const serverRes = await fetch(serverUrl, {
    headers: { 'X-Internal-Secret': BURN0_INTERNAL_SECRET },
  })

  if (!serverRes.ok || !serverRes.body) {
    return new Response('Stream unavailable', { status: 502 })
  }

  return new Response(serverRes.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/dashboard/events/stream/
git commit -m "feat: SSE proxy route for live event stream"
```

---

### Task 4: App — Events page with SSE + sidebar nav

**Repo:** `burn0-app`

**Files:**
- Modify: `src/app/dashboard/events/page.tsx` (stashed)
- Modify: `src/app/dashboard/sidebar-nav.tsx` (stashed)

- [ ] **Step 1: Update events page to use SSE instead of polling**

The stashed page uses `setInterval` polling. Replace the auto-refresh logic with SSE. Key changes to `src/app/dashboard/events/page.tsx`:

1. Remove the `autoRefresh` state and `setInterval` logic
2. Add SSE connection via `EventSource`:

```typescript
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const source = new EventSource('/api/dashboard/events/stream')

    source.onopen = () => setConnected(true)

    source.onmessage = (e) => {
      try {
        const newEvent = JSON.parse(e.data) as Event
        // Apply service filter client-side
        if (serviceFilter && newEvent.service !== serviceFilter) return
        setEvents(prev => [newEvent, ...prev.slice(0, 199)])
        setTotal(prev => prev + 1)
      } catch {}
    }

    source.onerror = () => {
      setConnected(false)
    }

    return () => source.close()
  }, [serviceFilter])
```

3. Update the live indicator to use `connected` state:
```tsx
<span className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
  connected
    ? 'border-success/30 bg-success/5 text-success'
    : 'border-warning/30 bg-warning/5 text-warning'
}`}>
  {connected ? '● Live' : '○ Reconnecting'}
</span>
```

4. Add a brief highlight animation for new events — use a CSS class like `animate-highlight` that flashes the row background briefly. Add to each new SSE event:
```typescript
setEvents(prev => [{ ...newEvent, _isNew: true }, ...prev.slice(0, 199)])
```
Then in the row: `className={event._isNew ? 'animate-pulse' : ''}` (using Tailwind's built-in pulse, or a custom animation).

- [ ] **Step 2: Verify sidebar has Events nav**

The stash should have added the Events nav item to `sidebar-nav.tsx`. Verify it's there with the queue-list icon SVG. If not, add it between Overview and API Keys:

```typescript
  {
    href: '/dashboard/events',
    label: 'Events',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
      </svg>
    ),
  },
```

- [ ] **Step 3: Test the full flow**

1. Start server: `cd burn0-server && npm run dev`
2. Start app: `cd burn0-app && npm run dev`
3. Login to dashboard
4. Navigate to Events page — should show existing events
5. Send a test event to the server via curl
6. Event should appear on the events page in real-time via SSE

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/events/ src/app/dashboard/sidebar-nav.tsx
git commit -m "feat: live event feed with SSE, Events nav in sidebar"
```

---

### Task 5: App — Monthly projection in dashboard

**Repo:** `burn0-app`

**Files:**
- Modify: `src/app/dashboard/cost-dashboard.tsx`

- [ ] **Step 1: Add projection calculation**

In `cost-dashboard.tsx`, after the existing `avgCostPerCall` calculation, add:

```typescript
  const dailyRate = days > 0 ? apiCost / days : 0
  const monthlyProjection = (dailyRate * 30) + infraCost
```

- [ ] **Step 2: Update stat cards to show projection**

Replace the first stat card from "Total Spend" to "Monthly Projection":

```tsx
<StatCard
  label="Monthly Projection"
  value={totalCalls > 0 ? `~${formatCost(monthlyProjection)}/mo` : 'No data'}
  sub={totalCalls > 0 ? `based on last ${days === 1 ? 'day' : `${days} days`}` : undefined}
  accent
/>
```

Keep the remaining stat cards (Spend, API Calls, Tokens In, Tokens Out) but shift "Spend" to second position.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/cost-dashboard.tsx
git commit -m "feat: monthly projection stat card in dashboard"
```

---

### Task 6: SDK — Projection in ticker exit summary + report

**Repo:** `burn0` (`/Users/srn/Documents/code/burn0-repo/burn0`)

**Files:**
- Modify: `src/transport/logger.ts`
- Modify: `src/cli/report.ts`

- [ ] **Step 1: Add projection to ticker exit summary**

In `src/transport/logger.ts`, in the `printExitSummary` function, modify the exit line that shows costs (the `else` branch around line 140):

Change from:
```typescript
line = `\n  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GRAY}session:${RESET} ${GREEN}${formatCost(sessionCost)}${RESET} ${GRAY}(${sessionCalls} calls, ${duration})${RESET} ${GRAY}──${RESET} ${GRAY}today:${RESET} ${GREEN}${formatCost(todayCost)}${RESET}\n`
```

To:
```typescript
const monthlyEst = todayCost > 0 ? formatCost(todayCost * 30) : null
const projPart = monthlyEst ? ` ${GRAY}──${RESET} ${GRAY}~${GREEN}${monthlyEst}${RESET}${GRAY}/mo${RESET}` : ''
line = `\n  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GRAY}session:${RESET} ${GREEN}${formatCost(sessionCost)}${RESET} ${GRAY}(${sessionCalls} calls, ${duration})${RESET} ${GRAY}──${RESET} ${GRAY}today:${RESET} ${GREEN}${formatCost(todayCost)}${RESET}${projPart}\n`
```

- [ ] **Step 2: Add projection to CLI report**

In `src/cli/report.ts`, in the `renderCostReport` function, after the daily breakdown section and before the final `console.log()`, add:

```typescript
  // Projection
  if (data.total.cost > 0) {
    const daysInPeriod = showDaily ? 7 : 1  // 7 for default, 1 for --today
    const dailyRate = data.total.cost / daysInPeriod
    const monthly = dailyRate * 30
    console.log(`\n  ${chalk.gray('── projection ─────────────────────────────')}`)
    console.log(`  ${chalk.gray('~')}${chalk.green(formatCost(monthly))}${chalk.gray('/mo estimated')} ${chalk.dim(`(based on ${isToday ? 'today' : 'last 7 days'})`)}`)
  }
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/srn/Documents/code/burn0-repo/burn0
npx vitest run
```

- [ ] **Step 4: Build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/transport/logger.ts src/cli/report.ts
git commit -m "feat: monthly projection in ticker exit summary and CLI report"
```

---

### Task 7: Final integration test

- [ ] **Step 1: Start all services**

```bash
# Terminal 1: Server
cd /Users/srn/Documents/code/burn0-repo/burn0-server && npm run dev

# Terminal 2: App
cd /Users/srn/Documents/code/burn0-repo/burn0-app && npm run dev

# Terminal 3: Test project
cd /Users/srn/Documents/code/burn0-repo/burn0-test-project && npm run dev
```

- [ ] **Step 2: Test live event feed**

1. Open dashboard at `http://localhost:3001/dashboard/events`
2. Run `./test-burn0.sh` in the test project
3. Events should appear in real-time on the dashboard
4. Click an event — detail modal should show all fields
5. Filter by service — should filter the list

- [ ] **Step 3: Test projection**

1. Dashboard overview should show `~$X/mo` as the first stat card
2. In the test project: `npx burn0 report` should show projection at the bottom
3. Ctrl+C the test server — exit summary should show `~$X/mo`

- [ ] **Step 4: Fix any issues and commit across all repos**
