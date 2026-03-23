# Auth + API Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub OAuth login and self-service API key management across the burn0 app and server.

**Architecture:** Server gets internal auth middleware, user find-or-create endpoint, and key CRUD endpoints. App gets NextAuth v5 with GitHub provider (JWT sessions, no MongoDB adapter), dashboard pages, and API route proxies that call the server with an internal secret.

**Tech Stack:** Express (server), Next.js 16 + NextAuth v5 (app), MongoDB, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-auth-and-api-keys.md`

---

### File Map

**Server (`burn0-server`):**

| File | Action | Responsibility |
|---|---|---|
| `src/config.ts` | Modify | Add `internalSecret` to config |
| `src/db.ts` | Modify | Add indexes for `users` and `api_keys.userId` |
| `src/middleware/internal.ts` | Create | Validate `X-Internal-Secret` header |
| `src/routes/auth.ts` | Create | `POST /v1/auth/user` — find or create user |
| `src/routes/keys.ts` | Create | Key CRUD: create, list, revoke |
| `src/index.ts` | Modify | Register new routes |

**App (`burn0-app`):**

| File | Action | Responsibility |
|---|---|---|
| `src/lib/auth.ts` | Create | NextAuth config — GitHub provider, JWT callbacks, server call on signIn |
| `src/lib/server-client.ts` | Create | Helper to call burn0-server with internal secret |
| `src/app/api/auth/[...nextauth]/route.ts` | Create | NextAuth route handler |
| `src/app/api/keys/route.ts` | Create | POST + GET proxy to server |
| `src/app/api/keys/[id]/route.ts` | Create | DELETE proxy to server |
| `src/middleware.ts` | Create | Protect `/dashboard/*` routes |
| `src/app/login/page.tsx` | Create | GitHub login page |
| `src/app/dashboard/layout.tsx` | Create | Dashboard layout (separate from marketing) |
| `src/app/dashboard/page.tsx` | Create | Dashboard home |
| `src/app/dashboard/keys/page.tsx` | Create | API key management UI |
| `src/app/layout.tsx` | Modify | Add `<SessionProvider>` |

---

### Task 1: Server — config + internal auth middleware + DB indexes

**Repo:** `burn0-server` (`/Users/srn/Documents/code/burn0-repo/burn0-server`)

**Files:**
- Modify: `src/config.ts`
- Create: `src/middleware/internal.ts`
- Modify: `src/db.ts`

- [ ] **Step 1: Add `internalSecret` to config**

In `src/config.ts`, add `internalSecret` to the interface and `getConfig()`:

```typescript
export interface Config {
  mongoUri: string
  port: number
  corsOrigin: string
  workerPollIntervalMs: number
  workerBatchSize: number
  internalSecret: string
}

export function getConfig(): Config {
  const internalSecret = process.env.BURN0_INTERNAL_SECRET
  if (!internalSecret) {
    throw new Error('BURN0_INTERNAL_SECRET is required')
  }

  return {
    mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/burn0',
    port: parseInt(process.env.PORT ?? '3001', 10),
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    workerPollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? '5000', 10),
    workerBatchSize: parseInt(process.env.WORKER_BATCH_SIZE ?? '100', 10),
    internalSecret,
  }
}
```

- [ ] **Step 2: Create internal auth middleware**

Create `src/middleware/internal.ts`:

```typescript
import type { Request, Response, NextFunction } from 'express'
import { getConfig } from '../config'

export function requireInternalSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers['x-internal-secret']
  const config = getConfig()

  if (!secret || secret !== config.internalSecret) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}
```

- [ ] **Step 3: Add DB indexes**

In `src/db.ts`, add indexes after the existing ones (inside `connectDb()`):

```typescript
  // New indexes for auth + key management
  await db.collection('users').createIndex({ githubId: 1 }, { unique: true })
  await db.collection('api_keys').createIndex({ userId: 1 })
```

- [ ] **Step 4: Verify server starts**

Run: `npm run dev`
Expected: Server starts without errors (BURN0_INTERNAL_SECRET is set in `.env`)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/middleware/internal.ts src/db.ts
git commit -m "feat: add internal secret auth middleware and DB indexes"
```

---

### Task 2: Server — user find-or-create endpoint

**Repo:** `burn0-server`

**Files:**
- Create: `src/routes/auth.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create `src/routes/auth.ts`**

```typescript
import { Router } from 'express'
import { getDb } from '../db'
import { requireInternalSecret } from '../middleware/internal'

const router = Router()

router.post('/v1/auth/user', requireInternalSecret, async (req, res) => {
  try {
    const { githubId, name, email, image } = req.body

    if (!githubId) {
      res.status(400).json({ error: 'githubId is required' })
      return
    }

    const db = getDb()
    const now = new Date()

    const result = await db.collection('users').findOneAndUpdate(
      { githubId: String(githubId) },
      {
        $set: { name, email, image, updatedAt: now },
        $setOnInsert: { githubId: String(githubId), createdAt: now },
      },
      { upsert: true, returnDocument: 'after' }
    )

    const user = result!
    res.json({
      id: user._id.toString(),
      githubId: user.githubId,
      name: user.name,
      email: user.email,
      image: user.image,
    })
  } catch (err: any) {
    console.error('[burn0] Auth error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
```

- [ ] **Step 2: Register route in `src/index.ts`**

Add import and use:

```typescript
import authRouter from './routes/auth'
```

And in the routes section:

```typescript
  app.use(authRouter)
```

- [ ] **Step 3: Test with curl**

```bash
curl -X POST http://localhost:7001/v1/auth/user \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: 071a3dd5f10e41d311e9ba9180756683eb25846e7cac494364e9ea8f00250d4e" \
  -d '{"githubId":"12345","name":"Test User","email":"test@test.com","image":"https://example.com/avatar.png"}'
```

Expected: `{ "id": "...", "githubId": "12345", "name": "Test User", ... }`

Test without secret:
```bash
curl -X POST http://localhost:7001/v1/auth/user \
  -H "Content-Type: application/json" \
  -d '{"githubId":"12345"}'
```

Expected: `{ "error": "Unauthorized" }` with 401

- [ ] **Step 4: Commit**

```bash
git add src/routes/auth.ts src/index.ts
git commit -m "feat: add user find-or-create endpoint"
```

---

### Task 3: Server — API key CRUD endpoints

**Repo:** `burn0-server`

**Files:**
- Create: `src/routes/keys.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create `src/routes/keys.ts`**

```typescript
import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { getDb } from '../db'
import { requireInternalSecret } from '../middleware/internal'

const router = Router()

// Create API key
router.post('/v1/keys', requireInternalSecret, async (req, res) => {
  try {
    const { userId, name, projectName } = req.body

    if (!userId || !name) {
      res.status(400).json({ error: 'userId and name are required' })
      return
    }

    const key = 'b0_sk_' + randomBytes(16).toString('hex')
    const now = new Date()

    const db = getDb()
    const result = await db.collection('api_keys').insertOne({
      key,
      active: true,
      project_name: projectName || name,
      userId,
      name,
      createdAt: now,
    })

    res.status(201).json({
      id: result.insertedId.toString(),
      key,
      name,
      projectName: projectName || name,
      createdAt: now.toISOString(),
    })
  } catch (err: any) {
    console.error('[burn0] Key creation error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// List user's keys
router.get('/v1/keys', requireInternalSecret, async (req, res) => {
  try {
    const userId = req.query.userId as string
    if (!userId) {
      res.status(400).json({ error: 'userId query parameter is required' })
      return
    }

    const db = getDb()
    const keys = await db.collection('api_keys')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray()

    res.json({
      keys: keys.map(k => ({
        id: k._id.toString(),
        name: k.name || 'Unnamed',
        projectName: k.project_name,
        prefix: k.key.slice(0, 10) + '....',
        active: k.active,
        createdAt: k.createdAt?.toISOString?.() || null,
      })),
    })
  } catch (err: any) {
    console.error('[burn0] Key list error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Revoke key
router.delete('/v1/keys/:id', requireInternalSecret, async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.query.userId as string

    if (!userId) {
      res.status(400).json({ error: 'userId query parameter is required' })
      return
    }

    let objectId: ObjectId
    try {
      objectId = new ObjectId(id)
    } catch {
      res.status(404).json({ error: 'Key not found' })
      return
    }

    const db = getDb()
    const key = await db.collection('api_keys').findOne({ _id: objectId })

    if (!key) {
      res.status(404).json({ error: 'Key not found' })
      return
    }

    if (key.userId && key.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    await db.collection('api_keys').updateOne(
      { _id: objectId },
      { $set: { active: false } }
    )

    res.json({ ok: true })
  } catch (err: any) {
    console.error('[burn0] Key revoke error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
```

- [ ] **Step 2: Register route in `src/index.ts`**

Add import:
```typescript
import keysRouter from './routes/keys'
```

And in routes section:
```typescript
  app.use(keysRouter)
```

- [ ] **Step 3: Test with curl**

Create key:
```bash
curl -X POST http://localhost:7001/v1/keys \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: 071a3dd5f10e41d311e9ba9180756683eb25846e7cac494364e9ea8f00250d4e" \
  -d '{"userId":"testuser123","name":"dev laptop","projectName":"my-app"}'
```

List keys:
```bash
curl "http://localhost:7001/v1/keys?userId=testuser123" \
  -H "X-Internal-Secret: 071a3dd5f10e41d311e9ba9180756683eb25846e7cac494364e9ea8f00250d4e"
```

Revoke key (use the id from the create response):
```bash
curl -X DELETE "http://localhost:7001/v1/keys/REPLACE_ID?userId=testuser123" \
  -H "X-Internal-Secret: 071a3dd5f10e41d311e9ba9180756683eb25846e7cac494364e9ea8f00250d4e"
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/keys.ts src/index.ts
git commit -m "feat: add API key CRUD endpoints"
```

---

### Task 4: App — install NextAuth + set up auth

**Repo:** `burn0-app` (`/Users/srn/Documents/code/burn0-repo/burn0-app`)

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/lib/server-client.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/srn/Documents/code/burn0-repo/burn0-app
npm install next-auth@beta
```

Note: if NextAuth v5 beta doesn't work with Next.js 16, try `npm install next-auth@latest` or `npm install @auth/core @auth/nextjs`.

- [ ] **Step 2: Create `src/lib/server-client.ts`**

```typescript
const BURN0_SERVER_URL = process.env.BURN0_SERVER_URL ?? 'http://localhost:7001'
const BURN0_INTERNAL_SECRET = process.env.BURN0_INTERNAL_SECRET ?? ''

export async function serverFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BURN0_SERVER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': BURN0_INTERNAL_SECRET,
      ...options.headers,
    },
  })
}
```

- [ ] **Step 3: Create `src/lib/auth.ts`**

```typescript
import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import { serverFetch } from './server-client'

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
    }),
  ],
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === 'github' && profile) {
        try {
          const res = await serverFetch('/v1/auth/user', {
            method: 'POST',
            body: JSON.stringify({
              githubId: String(profile.id),
              name: profile.name || user.name,
              email: profile.email || user.email,
              image: (profile as any).avatar_url || user.image,
            }),
          })
          if (res.ok) {
            const data = await res.json()
            ;(user as any).serverId = data.id
          }
        } catch (err) {
          console.error('[burn0] Failed to sync user with server:', err)
        }
      }
      return true
    },
    async jwt({ token, user }) {
      if (user && (user as any).serverId) {
        token.serverId = (user as any).serverId
      }
      return token
    },
    async session({ session, token }) {
      if (token.serverId) {
        session.user.id = token.serverId as string
      }
      return session
    },
  },
})
```

- [ ] **Step 4: Create `src/app/api/auth/[...nextauth]/route.ts`**

```typescript
import { handlers } from '@/lib/auth'

export const { GET, POST } = handlers
```

- [ ] **Step 5: Update `src/app/layout.tsx`**

Add `SessionProvider` wrapper. Import at the top:

```typescript
import { SessionProvider } from 'next-auth/react'
```

Wrap the body content:

```tsx
<body className="min-h-screen flex flex-col antialiased">
  <SessionProvider>
    <SkipToContent />
    <Header />
    <main className="flex-1">{children}</main>
    <Footer />
  </SessionProvider>
</body>
```

Note: `SessionProvider` is a client component. If the layout is a server component, you may need to create a `src/components/providers.tsx` client component wrapper instead:

```typescript
'use client'
import { SessionProvider } from 'next-auth/react'

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
```

Then use `<Providers>` in layout.tsx.

- [ ] **Step 6: Test — start the app**

```bash
npm run dev
```

Visit `http://localhost:3000/api/auth/signin` — should show GitHub login option.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth.ts src/lib/server-client.ts src/app/api/auth/ src/app/layout.tsx
git commit -m "feat: add NextAuth with GitHub provider"
```

---

### Task 5: App — login page + middleware

**Repo:** `burn0-app`

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/middleware.ts`

- [ ] **Step 1: Create `src/app/login/page.tsx`**

```tsx
import { auth, signIn } from '@/lib/auth'
import { redirect } from 'next/navigation'

export default async function LoginPage() {
  const session = await auth()
  if (session) redirect('/dashboard')

  return (
    <div className="flex-1 flex items-center justify-center min-h-[60vh]">
      <div className="text-center space-y-6">
        <h1 className="text-3xl font-bold">Sign in to burn0</h1>
        <p className="text-muted-foreground">Track your API costs across every service.</p>
        <form
          action={async () => {
            'use server'
            await signIn('github', { redirectTo: '/dashboard' })
          }}
        >
          <button
            type="submit"
            className="inline-flex items-center gap-2 px-6 py-3 bg-white text-black rounded-lg font-medium hover:bg-gray-100 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            Sign in with GitHub
          </button>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/middleware.ts`**

```typescript
import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  const isAuth = !!req.auth
  const isDashboard = req.nextUrl.pathname.startsWith('/dashboard')

  if (isDashboard && !isAuth) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: ['/dashboard/:path*'],
}
```

- [ ] **Step 3: Test login flow**

1. Visit `http://localhost:3000/login`
2. Click "Sign in with GitHub"
3. Authorize the app on GitHub
4. Should redirect to `/dashboard` (404 is fine — page doesn't exist yet)
5. Check server logs — should see the user creation call

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx src/middleware.ts
git commit -m "feat: add login page and dashboard middleware"
```

---

### Task 6: App — dashboard pages + key management

**Repo:** `burn0-app`

**Files:**
- Create: `src/app/dashboard/layout.tsx`
- Create: `src/app/dashboard/page.tsx`
- Create: `src/app/dashboard/keys/page.tsx`
- Create: `src/app/api/keys/route.ts`
- Create: `src/app/api/keys/[id]/route.ts`

- [ ] **Step 1: Create `src/app/api/keys/route.ts`**

```typescript
import { auth } from '@/lib/auth'
import { serverFetch } from '@/lib/server-client'
import { NextResponse } from 'next/server'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await serverFetch(`/v1/keys?userId=${session.user.id}`)
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const res = await serverFetch('/v1/keys', {
    method: 'POST',
    body: JSON.stringify({
      userId: session.user.id,
      name: body.name,
      projectName: body.projectName,
    }),
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
```

- [ ] **Step 2: Create `src/app/api/keys/[id]/route.ts`**

```typescript
import { auth } from '@/lib/auth'
import { serverFetch } from '@/lib/server-client'
import { NextResponse } from 'next/server'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const res = await serverFetch(`/v1/keys/${id}?userId=${session.user.id}`, {
    method: 'DELETE',
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
```

- [ ] **Step 3: Create `src/app/dashboard/layout.tsx`**

```tsx
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session) redirect('/login')

  return <>{children}</>
}
```

- [ ] **Step 4: Create `src/app/dashboard/page.tsx`**

```tsx
import { auth } from '@/lib/auth'
import Link from 'next/link'

export default async function DashboardPage() {
  const session = await auth()
  const user = session!.user

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="flex items-center gap-4 mb-8">
        {user.image && (
          <img src={user.image} alt="" className="w-12 h-12 rounded-full" />
        )}
        <div>
          <h1 className="text-2xl font-bold">{user.name}</h1>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
      </div>

      <div className="grid gap-4">
        <Link
          href="/dashboard/keys"
          className="block p-6 rounded-lg border border-border hover:border-foreground/20 transition-colors"
        >
          <h2 className="text-lg font-semibold mb-1">API Keys</h2>
          <p className="text-sm text-muted-foreground">Create and manage your burn0 API keys</p>
        </Link>

        <div className="p-6 rounded-lg border border-border opacity-50">
          <h2 className="text-lg font-semibold mb-1">Cost Dashboard</h2>
          <p className="text-sm text-muted-foreground">Coming soon — view your API costs and trends</p>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Create `src/app/dashboard/keys/page.tsx`**

```tsx
'use client'

import { useState, useEffect } from 'react'

interface ApiKey {
  id: string
  name: string
  projectName: string
  prefix: string
  active: boolean
  createdAt: string
}

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyProject, setNewKeyProject] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showForm, setShowForm] = useState(false)

  async function loadKeys() {
    const res = await fetch('/api/keys')
    const data = await res.json()
    setKeys(data.keys || [])
    setLoading(false)
  }

  useEffect(() => { loadKeys() }, [])

  async function createKey() {
    if (!newKeyName.trim()) return
    setCreating(true)

    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newKeyName, projectName: newKeyProject || newKeyName }),
    })

    const data = await res.json()
    if (data.key) {
      setCreatedKey(data.key)
      setNewKeyName('')
      setNewKeyProject('')
      setShowForm(false)
      loadKeys()
    }
    setCreating(false)
  }

  async function revokeKey(id: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return

    await fetch(`/api/keys/${id}`, { method: 'DELETE' })
    loadKeys()
  }

  function copyKey() {
    if (createdKey) navigator.clipboard.writeText(createdKey)
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">API Keys</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-white text-black rounded-lg font-medium hover:bg-gray-100 transition-colors text-sm"
        >
          Create new key
        </button>
      </div>

      {createdKey && (
        <div className="mb-6 p-4 rounded-lg border border-green-500/30 bg-green-500/5">
          <p className="text-sm font-medium text-green-400 mb-2">API key created — copy it now, it won't be shown again</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-black/50 rounded text-sm font-mono break-all">{createdKey}</code>
            <button onClick={copyKey} className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 text-sm">Copy</button>
          </div>
          <button onClick={() => setCreatedKey(null)} className="mt-2 text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
        </div>
      )}

      {showForm && (
        <div className="mb-6 p-4 rounded-lg border border-border">
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Key name (e.g., dev laptop)"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
            <input
              type="text"
              placeholder="Project name (optional)"
              value={newKeyProject}
              onChange={(e) => setNewKeyProject(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
            />
            <button
              onClick={createKey}
              disabled={creating || !newKeyName.trim()}
              className="px-4 py-2 bg-white text-black rounded-lg font-medium hover:bg-gray-100 transition-colors text-sm disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create key'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : keys.length === 0 ? (
        <p className="text-muted-foreground">No API keys yet. Create one to start tracking costs.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between p-4 rounded-lg border border-border">
              <div>
                <p className="font-medium">{key.name}</p>
                <p className="text-sm text-muted-foreground">
                  <code className="font-mono">{key.prefix}</code>
                  {' · '}
                  {key.projectName}
                  {' · '}
                  {key.active ? (
                    <span className="text-green-400">Active</span>
                  ) : (
                    <span className="text-red-400">Revoked</span>
                  )}
                </p>
              </div>
              {key.active && (
                <button
                  onClick={() => revokeKey(key.id)}
                  className="px-3 py-1 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Test the full flow**

1. Start server: `cd burn0-server && npm run dev`
2. Start app: `cd burn0-app && npm run dev`
3. Visit `http://localhost:3000/login` → sign in with GitHub
4. Redirected to `/dashboard` → see your profile
5. Click "API Keys" → see empty list
6. Click "Create new key" → enter name → create
7. See the full key displayed → copy it
8. Dismiss → key shows as prefix in the list
9. Click "Revoke" → key marked as revoked

- [ ] **Step 7: Commit**

```bash
git add src/app/dashboard/ src/app/api/keys/
git commit -m "feat: add dashboard with API key management"
```

---

### Task 7: Final integration test

- [ ] **Step 1: Full flow test**

1. Fresh login → create key → use key in burn0 SDK → see costs in `burn0 report`
2. Revoke key → SDK should get 401 from server

- [ ] **Step 2: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues"
```
