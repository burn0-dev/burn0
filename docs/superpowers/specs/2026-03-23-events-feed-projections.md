# Live Event Feed + Monthly Projections — Design Spec

## Problem

The burn0 dashboard only shows aggregated cost data. Users can't see individual API calls as they happen. Small cost numbers ($0.0002) feel meaningless without context. There's no projection to answer "what will this cost me at scale?"

## Solution

Add a live event feed to the dashboard (via SSE) that shows every API call in real-time with cost. Add monthly cost projections to the dashboard, CLI ticker, and CLI report.

## Prerequisite

There is partial implementation stashed in both repos from prior work. The server has `src/routes/events-list.ts` (REST endpoint only, not registered in index.ts). The app has `src/app/dashboard/events/page.tsx` (polling-based, not SSE). These exist but need modification — not creation from scratch. The implementation plan should note these as "Modify" not "Create".

## Constraint

The worker and Express server run in the same process (`startWorker()` is called inside `main()` in `index.ts`). The EventEmitter approach depends on this. If the worker is ever extracted to a separate process, the emitter must be replaced with a pub/sub mechanism (Redis, etc.).

## Live Event Feed

### Server Endpoints (burn0-server)

#### `GET /v1/dashboard/events` — REST (initial load)

Returns paginated list of recent processed events for a user's projects.

Request: `?userId=...&limit=50&offset=0&service=openai&project=my-app`

All params except `userId` are optional. Protected by `X-Internal-Secret`.

Response:
```json
{
  "events": [
    {
      "id": "...",
      "service": "openai",
      "endpoint": "/v1/chat/completions",
      "model": "gpt-4o-mini",
      "method": "POST",
      "tokens_in": 500,
      "tokens_out": 128,
      "status_code": 200,
      "duration_ms": 342,
      "cost": 0.000152,
      "cost_breakdown": "input: 500 tokens × $0.15/1M = $0.000075, output: 128 tokens × $0.60/1M = $0.000077",
      "timestamp": "2026-03-23T12:00:00Z",
      "project_name": "my-app",
      "feature": null,
      "metadata": null,
      "estimated": false
    }
  ],
  "total": 142,
  "limit": 50,
  "offset": 0
}
```

**Requires compound index:** `{ project_name: 1, status: 1, timestamp: -1 }` — add to `db.ts`. The existing index `{ project_name: 1, timestamp: -1 }` partially covers this but adding `status` makes the events-list query efficient.

#### `GET /v1/dashboard/events/stream` — SSE (real-time)

Server-Sent Events endpoint. Pushes new events as the worker processes them.

Request: `?userId=...` — protected by `X-Internal-Secret`.

The server:
1. Looks up the user's active API keys to get their project names
2. Sets response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
3. Sends a heartbeat comment every 30 seconds (`:heartbeat\n\n`) to keep the connection alive and detect dead clients
4. Listens to the shared EventEmitter for processed events
5. Filters events matching the user's project names
6. Sends each matching event as `data: {json}\n\n`
7. On `req.on('close')`: removes the listener from the emitter (prevents listener leak)

**Rate limiting:** If more than 10 events/second for a connection, batch them into a single SSE message with `event: batch\n` and `data: [{...}, {...}]\n\n`. The client handles both single events and batches.

### Event Emitter (burn0-server)

Create `src/worker/emitter.ts`:

```typescript
import { EventEmitter } from 'node:events'
const emitter = new EventEmitter()
emitter.setMaxListeners(100)
export default emitter
```

The worker emits after processing each event. The SSE endpoint subscribes and cleans up on disconnect:

```typescript
// In SSE endpoint:
const handler = (event) => { ... }
emitter.on('event:processed', handler)
req.on('close', () => emitter.removeListener('event:processed', handler))
```

### Dashboard Page (`/dashboard/events`)

Modify the existing stashed page to replace polling with SSE.

**On load:**
1. Fetch last 50 events via REST (`GET /api/dashboard/events`)
2. Open SSE connection via `EventSource('/api/dashboard/events/stream')`
3. New events from SSE prepend to the list with a brief highlight animation
4. If user scrolls up, auto-scroll pauses

**Table columns:**

| Column | Content |
|---|---|
| Time | Relative ("2s ago", "5m ago") |
| Service | Name with status dot (green=2xx, yellow=4xx, red=5xx) |
| Model/Endpoint | Model name for LLMs, endpoint path for APIs |
| Status | HTTP status code |
| Tokens | `500→128` for LLMs, `—` otherwise |
| Latency | `342ms` or `1.2s` |
| Cost | `$0.0012` in green |

**Click row → detail modal** with all fields: timestamp, project, service, endpoint, model, status, latency, cost, cost breakdown, tokens, feature, metadata, estimated flag.

**Service filter:** dropdown filters both the REST initial load and a client-side filter on SSE events.

**Live indicator:** green dot + "Live" when SSE is connected, yellow + "Reconnecting" when disconnected.

### SSE Proxy (Next.js App Router)

`GET /api/dashboard/events/stream` — this is a streaming response, not a standard `NextResponse`.

Implementation must use `ReadableStream`:
```typescript
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  const serverUrl = `${BURN0_SERVER_URL}/v1/dashboard/events/stream?userId=${session.user.id}`
  const serverRes = await fetch(serverUrl, {
    headers: { 'X-Internal-Secret': BURN0_INTERNAL_SECRET },
  })

  return new Response(serverRes.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
```

This pipes the server's SSE stream through to the browser. The `fetch` body is a `ReadableStream` which Next.js can forward.

### Sidebar

Add "Events" nav item between Overview and API Keys with this SVG icon (Heroicons `queue-list`):

```tsx
<svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
  <path d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
</svg>
```

## Monthly Projection

### Formula

```
dailyRate = apiCostInPeriod / daysInPeriod
monthlyProjection = (dailyRate * 30) + infraMonthlyCost
```

### Confidence indicator

- If `daysInPeriod < (selectedPeriod * 0.5)` → prefix with `~` (e.g., selected 7 days but only 3 days have data)
- Otherwise → show without prefix
- Sub-text always shows basis: "based on last 7 days"

### Where it appears

**Dashboard overview (stat card):**
- First stat card, most prominent
- Shows: `~$47/mo`
- Sub: "based on last 7 days"

**CLI ticker exit summary:**
```
burn0 ▸ session: $0.47 (12 calls, 4m 22s) ── today: $14.32 ── ~$430/mo
```
- Uses today's cost × 30 as the projection (no infra — CLI doesn't have infra data)
- Always shows `~` prefix since it's based on a single session/day

**CLI report (bottom of report):**
```
  ── projection ─────────────────────────────
  ~$47/mo estimated (based on last 7 days)
```
- Uses the same period as the report (7 days default, 1 day for --today)
- No infra — CLI only has local ledger data, not project config

### CLI projection data source

The CLI does NOT have access to infra monthly costs (those are stored server-side in `project_configs`). CLI projections are API-call-only:
- **Ticker:** `todayCost * 30`
- **Report (local mode):** `totalCostInPeriod / daysInPeriod * 30`
- **Report (backend mode):** server's `/v1/report` response — add `projection_monthly` field. Note: the existing `/v1/report` endpoint (SDK Bearer auth) returns `{ total_cost, total_events, by_service, ... }` but the CLI's `fetchBackendReport` expects `{ total: { cost }, byService: [] }`. The implementation must reconcile this — either fix the CLI to map the actual response shape, or update the server to return a consistent shape. Add `projection_monthly` (computed as `total_cost / days * 30`) to the `/v1/report` response (the SDK-authenticated endpoint, not the dashboard one).

## Files to Change

### Server (`burn0-server`)

| File | Action | Purpose |
|---|---|---|
| `src/worker/emitter.ts` | Create | Shared EventEmitter singleton |
| `src/routes/events-list.ts` | Modify (stashed) | Add SSE stream endpoint alongside existing REST |
| `src/worker/processor.ts` | Modify | Emit processed events to emitter |
| `src/index.ts` | Modify | Register events-list route (currently not wired) |
| `src/db.ts` | Modify | Add compound index for events-list query |
| `src/routes/report.ts` | Modify | Add `projection_monthly` to report response |

### App (`burn0-app`)

| File | Action | Purpose |
|---|---|---|
| `src/app/dashboard/events/page.tsx` | Modify (stashed) | Replace polling with SSE, add highlight animation |
| `src/app/api/dashboard/events/route.ts` | Modify (stashed) | Already exists, verify it works |
| `src/app/api/dashboard/events/stream/route.ts` | Create | SSE proxy using ReadableStream |
| `src/app/dashboard/sidebar-nav.tsx` | Modify | Add Events nav item with icon |
| `src/app/dashboard/cost-dashboard.tsx` | Modify | Add monthly projection as first stat card |

### SDK (`burn0`)

| File | Action | Purpose |
|---|---|---|
| `src/transport/logger.ts` | Modify | Add `~$X/mo` to exit summary |
| `src/cli/report.ts` | Modify | Add projection line at bottom, use server projection if available |

## Edge Cases

- **No events yet:** empty state "Events will appear here as your app makes API calls"
- **SSE connection drops:** browser `EventSource` auto-reconnects. On reconnect, re-fetch via REST to fill gaps.
- **Multiple tabs:** each opens its own SSE connection. EventEmitter handles multiple listeners. Cleanup on `close`.
- **No active keys:** return empty list, don't open SSE
- **High event volume:** batch SSE messages at 10/second threshold
- **Dead connections:** 30-second heartbeat. `req.on('close')` removes listener.
- **Projection with 0 data:** show "No data yet" not "$0/mo"
- **Projection infra-only (no API calls):** show "$45/mo (infra only)"

## Implementation Order

1. Server: EventEmitter + register existing REST endpoint + add SSE endpoint
2. Server: Worker emits events + add projection to report
3. App: SSE proxy route
4. App: Events page with SSE (modify stashed polling version)
5. App: Monthly projection stat card in dashboard
6. SDK: Projection in ticker exit summary + report
