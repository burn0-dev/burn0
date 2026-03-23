<p align="center">
  <strong>burn0</strong> — Know what your code costs
</p>

<p align="center">
  One import tracks every API call in your stack. LLMs, SaaS, infrastructure.<br/>
  See per-request costs in real time. Open source.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@burn0/burn0"><img src="https://img.shields.io/npm/v/@burn0/burn0.svg" alt="npm version"></a>
  <a href="https://github.com/burn0-dev/burn0/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@burn0/burn0.svg" alt="license"></a>
  <a href="https://docs.burn0.dev"><img src="https://img.shields.io/badge/docs-burn0.dev-orange" alt="docs"></a>
</p>

---

## What is burn0?

burn0 is a lightweight npm package that automatically tracks the cost of every outbound API call your app makes — LLM providers, payment APIs, email services, and more.

```
  burn0 ▸ $4.32 today (47 calls) ── openai: $3.80 · anthropic: $0.52
```

No proxy. No code changes. One import.

## Quick Start

```bash
npm i @burn0/burn0
```

Add one line to your entry file:

```typescript
import '@burn0/burn0'  // Must be first import

import express from 'express'
import OpenAI from 'openai'
// ... your app
```

Run your app. Costs appear in your terminal:

```
  burn0 ▸ $0.47 today (12 calls) ── openai: $0.41 · stripe: $0.06
```

On exit:

```
  burn0 ▸ session: $0.47 (12 calls, 4m 22s) ── today: $14.32 ── ~$430/mo
```

## CLI

```bash
# Setup wizard
npx burn0 init

# Cost report
npx burn0 report

# Today only
npx burn0 report --today

# Run app with tracking (no code changes)
npx burn0 dev -- node app.js

# Add API key
npx burn0 connect
```

### `burn0 report` output

```
  burn0 report ── last 7 days

  Total: $12.47 (342 calls)

  openai         $8.32   ██████████████░░░░░░  67%
  anthropic      $3.15   ██████░░░░░░░░░░░░░░  25%
  google-gemini  $0.85   ██░░░░░░░░░░░░░░░░░░   7%
  resend         $0.15   ░░░░░░░░░░░░░░░░░░░░   1%

  ── projection ─────────────────────────────
  ~$53/mo estimated (based on last 7 days)
```

## Feature Attribution

Track costs per feature or per user:

```typescript
import { track } from '@burn0/burn0'

await track('chat', { userId: 'user123' }, async () => {
  await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello' }],
  })
})
```

## 50+ Services Supported

### LLM Providers
OpenAI, Anthropic, Google Gemini, Mistral, Cohere, Groq, Together AI, Perplexity, Fireworks AI, DeepSeek, Replicate, AI21 Labs

### Pay-per-use APIs
Stripe, PayPal, SendGrid, Resend, Postmark, Mailgun, AWS SES, Twilio, Vonage, Clerk, Google Maps, Mapbox, Algolia, AWS S3, Cloudflare R2, and more

### Infrastructure (monthly plans)
Vercel, Supabase, Netlify, PlanetScale, MongoDB Atlas, Upstash, Neon, Turso, Firebase, AWS Lambda, Pinecone

[See full list →](https://docs.burn0.dev/reference/supported-services)

## Dashboard

Connect an API key to see costs in the browser at [burn0.dev/dashboard](https://burn0.dev/dashboard):

- **Live event feed** — every API call in real-time via SSE
- **Cost breakdown** — per service, per model, per day
- **Monthly projection** — estimated monthly spend
- **Infrastructure costs** — Vercel, Supabase, etc. plan costs
- **API key management** — create, list, revoke keys

```bash
# Sign in with GitHub at burn0.dev
# Create an API key
# Add to your project:
npx burn0 connect
```

## How It Works

1. `import '@burn0/burn0'` patches `globalThis.fetch` and `node:http`
2. Every outbound HTTP call is intercepted (your app's behavior is unchanged)
3. burn0 identifies the service from the hostname (e.g., `api.openai.com` → OpenAI)
4. Token counts and costs are extracted from response bodies
5. Costs are displayed in your terminal and optionally synced to the dashboard

burn0 never reads request/response content. It only extracts metadata: service name, model, token counts, status code, latency.

## Two Modes

| Mode | API Key | What happens |
|---|---|---|
| **Local** | No | Costs in terminal + local ledger. No network calls to burn0. |
| **Cloud** | Yes | Same as local + events sync to dashboard for team visibility. |

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `BURN0_API_KEY` | — | API key for cloud mode |
| `BURN0_API_URL` | `https://api.burn0.dev` | Backend URL |
| `BURN0_DEBUG` | `false` | Enable debug logging |
| `BURN0_ENABLE_TEST` | — | Set to `1` to enable in `NODE_ENV=test` |

## Requirements

- Node.js >= 18
- Works with any Node.js framework (Express, Next.js, Fastify, Hono, etc.)

## Documentation

Full docs at [docs.burn0.dev](https://docs.burn0.dev)

## License

MIT
