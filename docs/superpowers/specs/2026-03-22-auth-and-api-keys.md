# Auth + API Key Management — Design Spec

## Problem

burn0 has no user accounts. Users can't create API keys through the product — keys must be manually inserted into MongoDB. There's no login, no dashboard, no self-service key management.

## Solution

Add GitHub OAuth login to the app (NextAuth v5), API key management endpoints to the server, and a minimal dashboard UI for creating/managing keys.

## Architecture

```
User → burn0-app (NextAuth + dashboard)
         ↓ X-Internal-Secret + userId
       burn0-server (key CRUD + event ingestion)
         ↓
       MongoDB (users, api_keys, events)
```

- **App** handles auth UI, dashboard, and proxies key management requests to the server
- **Server** owns all data writes (keys, events). Validates requests via `X-Internal-Secret` header for app-to-server calls, and `Authorization: Bearer` for SDK-to-server calls
- **MongoDB** is shared — one database, multiple collections

## Auth (App — burn0-app)

### NextAuth v5 Setup

- Provider: GitHub OAuth
- Session strategy: JWT (stateless — no database sessions)
- **No MongoDB adapter** — the app has zero direct MongoDB dependency
- User persistence handled by the server via `POST /v1/auth/user` (see below)
- Environment variables: `GITHUB_ID`, `GITHUB_SECRET`, `AUTH_SECRET`, `AUTH_URL`, `BURN0_SERVER_URL`, `BURN0_INTERNAL_SECRET`
- `MONGODB_URI` is **not needed** in the app — removed from app `.env`

### Auth Flow

```
1. User clicks "Sign in with GitHub"
2. NextAuth redirects to GitHub OAuth
3. GitHub redirects back with profile data
4. NextAuth signIn callback → calls server POST /v1/auth/user
   with { githubId, name, email, image } + X-Internal-Secret
5. Server finds or creates user in MongoDB → returns { id }
6. NextAuth stores user.id in JWT token
7. User is logged in — JWT session contains user.id, name, email, image
```

### Server User Endpoint

#### `POST /v1/auth/user`

Find or create a user. Called by NextAuth on every login.

Request:
```json
{
  "githubId": "1024025",
  "name": "Linus Torvalds",
  "email": "torvalds@linux.org",
  "image": "https://avatars.githubusercontent.com/u/1024025"
}
```

Response (200):
```json
{
  "id": "507f1f77bcf86cd799439011",
  "githubId": "1024025",
  "name": "Linus Torvalds",
  "email": "torvalds@linux.org",
  "image": "https://avatars.githubusercontent.com/u/1024025"
}
```

If user with `githubId` exists → return it (update name/email/image if changed).
If not → create new document in `users` collection → return it.

Protected by `X-Internal-Secret` header.

### MongoDB `users` Collection (new)

```
{
  _id: ObjectId,
  githubId: string,      // unique, indexed
  name: string,
  email: string,
  image: string,
  createdAt: Date,
  updatedAt: Date
}
```

Index: `{ githubId: 1 }` (unique).

### Auth Files (App)

| File | Purpose |
|---|---|
| `src/lib/auth.ts` | NextAuth config — GitHub provider, JWT session, signIn callback calls server |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth API route handler |
| `src/middleware.ts` | Protect `/dashboard/*` routes — redirect to login if not authenticated |
| `src/app/login/page.tsx` | Login page with "Sign in with GitHub" button |
| `src/app/layout.tsx` | Wrap app in `<SessionProvider>` for auth state access |

### Auth Files (Server)

| File | Purpose |
|---|---|
| `src/routes/auth.ts` | `POST /v1/auth/user` — find or create user |

### NextAuth + Next.js 16 Compatibility

NextAuth v5 targets Next.js 13-15. Next.js 16 is very recent — test the integration early during implementation. If NextAuth v5 doesn't work with Next.js 16, fall back to the latest compatible version or use `@auth/core` directly.

### Session Shape

```typescript
{
  user: {
    id: string       // MongoDB ObjectId as string (from server)
    name: string     // GitHub display name
    email: string    // GitHub email
    image: string    // GitHub avatar URL
  }
}
```

The `id` field must be included in the JWT token (NextAuth doesn't include it by default). Use `callbacks.signIn` to call the server for user creation, then `callbacks.jwt` and `callbacks.session` to pass `user.id` through.

## API Key Management

### Server Endpoints (burn0-server)

All key management endpoints require `X-Internal-Secret` header matching `BURN0_INTERNAL_SECRET` env var.

#### `POST /v1/keys`

Create a new API key.

Request:
```json
{
  "userId": "507f1f77bcf86cd799439011",
  "name": "dev laptop",
  "projectName": "my-app"
}
```

Response (201):
```json
{
  "id": "507f1f77bcf86cd799439012",
  "key": "b0_sk_a1b2c3d4e5f6...",
  "name": "dev laptop",
  "projectName": "my-app",
  "createdAt": "2026-03-22T12:00:00Z"
}
```

Key format: `b0_sk_` + 32 random hex characters.
The full key is only returned once at creation time.

#### `GET /v1/keys?userId=...`

List user's API keys (key value is masked). Server must only return keys matching the provided `userId` — no enumeration of other users' keys is possible.

Response (200):
```json
{
  "keys": [
    {
      "id": "507f1f77bcf86cd799439012",
      "name": "dev laptop",
      "projectName": "my-app",
      "prefix": "b0_sk_a1b2....",
      "active": true,
      "createdAt": "2026-03-22T12:00:00Z"
    }
  ]
}
```

Only shows first 10 chars of key as `prefix`. Never returns the full key after creation.

#### `DELETE /v1/keys/:id?userId=...`

Revoke (deactivate) a key. Uses query parameter for `userId` (not request body — DELETE bodies are unreliable across HTTP clients/proxies).

Request headers: `X-Internal-Secret`
Query: `?userId=507f1f77bcf86cd799439011`

Response (200):
```json
{ "ok": true }
```

Error responses:
- 401: missing/invalid `X-Internal-Secret`
- 403: `userId` doesn't match key owner
- 404: key not found

Sets `active: false` on the key. Does not delete the document (keeps audit trail).

### Error Responses (all endpoints)

| Status | When |
|---|---|
| 401 | Missing or invalid `X-Internal-Secret` header |
| 400 | Missing required fields (`userId`, `name`) |
| 403 | `userId` doesn't match key owner (DELETE only) |
| 404 | Key not found (DELETE only) |

### Server Files (Key Management)

| File | Purpose |
|---|---|
| `src/routes/keys.ts` | Key CRUD endpoints |
| `src/routes/auth.ts` | User find-or-create endpoint |
| `src/middleware/internal.ts` | Validate `X-Internal-Secret` header |
| `src/config.ts` | Add `internalSecret` to config (server refuses to start without it) |
| `src/db.ts` | Add `userId` index on `api_keys`, `githubId` unique index on `users` |

### MongoDB `api_keys` Collection Update

Current schema:
```
{ key, active, project_name }
```

Updated schema:
```
{ key, active, project_name, userId, name, createdAt }
```

- `userId`: string — links to NextAuth `users._id`
- `name`: string — user-given label (e.g., "dev laptop", "production server")
- `createdAt`: Date
- Add index on `{ userId: 1 }` for listing keys by user (add in `db.ts` alongside existing indexes)
- API layer uses `projectName` (camelCase) in request/response, maps to `project_name` (snake_case) in MongoDB to stay consistent with existing `events` collection

Existing keys (without `userId`) continue to work for SDK auth — the `userId` is only needed for key management.

### Security Note

API keys are stored in plaintext in MongoDB (matching existing behavior). Key hashing (SHA-256 with prefix storage) should be added in a future security hardening pass. For now, the priority is getting the key management flow working.

## App Dashboard Pages

### `/login`

Simple page with "Sign in with GitHub" button. If already authenticated, redirect to `/dashboard`.

### `/dashboard`

Protected route. Shows:
- User's name + avatar from GitHub
- Quick stats placeholder (cost data comes in a future spec)
- Link to manage API keys

### `/dashboard/keys`

Protected route. Shows:
- List of user's API keys (name, prefix, status, created date)
- "Create new key" button → modal/form asking for key name + project name
- After creation: show the full key once with a copy button and warning "This won't be shown again"
- "Revoke" button per key → confirmation → sets key inactive

### App API Routes (proxy to server)

| Route | Purpose |
|---|---|
| `POST /api/keys` | Proxy to server `POST /v1/keys` with internal secret |
| `GET /api/keys` | Proxy to server `GET /v1/keys` with internal secret |
| `DELETE /api/keys/[id]` | Proxy to server `DELETE /v1/keys/:id` with internal secret |

These are Next.js API routes that:
1. Verify the user is authenticated (from NextAuth session)
2. Extract `userId` from session
3. Call the server with `X-Internal-Secret` + `userId`
4. Return the server's response

### App Files

| File | Purpose |
|---|---|
| `src/app/login/page.tsx` | GitHub login page |
| `src/app/dashboard/page.tsx` | Dashboard home |
| `src/app/dashboard/keys/page.tsx` | API key management UI |
| `src/app/api/keys/route.ts` | POST + GET proxy |
| `src/app/api/keys/[id]/route.ts` | DELETE proxy |
| `src/lib/server-client.ts` | Helper to call burn0-server with internal secret |

## Implementation Order

1. **Server: internal auth middleware + user endpoint + key endpoints** — can be tested independently with curl
2. **App: NextAuth setup** — GitHub login working, user creation via server
3. **App: dashboard + key management UI** — full flow working

## Edge Cases

- **User creates key with duplicate name:** allowed — names are labels, not unique identifiers
- **User tries to revoke another user's key:** server checks `userId` matches key's `userId`, returns 403
- **Server unreachable when app tries to create key:** show error in UI
- **User deletes GitHub account:** NextAuth session becomes invalid, user can't log in. Keys remain active (SDK still works)
- **Multiple users in same project:** each user has their own keys, all can point to the same `projectName`
- **Rate limiting:** not in this spec, add later if needed
- **CORS:** key management calls are always server-to-server (Next.js API routes → Express). Browser never calls the server directly for key operations. The proxy pattern is a hard requirement, not a convenience.
- **Key entropy:** `b0_sk_` + 32 hex chars = 128 bits of entropy. Acceptable for launch; consider bumping to 64 hex chars (256 bits) later.
