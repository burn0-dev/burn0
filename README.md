<div align="center">

<h1>🔥 burn0</h1>

<h3>Know what your code costs</h3>

<p>One import tracks every API call in your stack.<br>
LLMs, SaaS, infrastructure. See per-request costs in real time.<br><br>
<strong>The cost observability layer your codebase is missing.</strong></p>

<br>

<img src="https://img.shields.io/badge/🔥_One_Import-black?style=for-the-badge" alt="One import">&nbsp;
<img src="https://img.shields.io/badge/📊_50+_Services-blue?style=for-the-badge" alt="50+ services">&nbsp;
<img src="https://img.shields.io/badge/⚡_Sub--ms_Overhead-yellow?style=for-the-badge" alt="Sub-ms overhead">&nbsp;
<img src="https://img.shields.io/badge/🔓_MIT_Licensed-green?style=for-the-badge" alt="MIT licensed">

[![npm version](https://img.shields.io/npm/v/@burn0/burn0.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/@burn0/burn0)
[![npm downloads](https://img.shields.io/npm/dm/@burn0/burn0.svg?style=flat-square&color=blue)](https://npmjs.com/package/@burn0/burn0)
[![GitHub stars](https://img.shields.io/github/stars/burn0-dev/burn0?style=flat-square)](https://github.com/burn0-dev/burn0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

<br>

[Website](https://burn0.dev) · [Docs](https://docs.burn0.dev) · [Dashboard](https://burn0.dev/dashboard) · [Twitter](https://twitter.com/burn0dev)

</div>

---


### 🎬 See it in action


https://github.com/user-attachments/assets/56962fc8-b9cf-49b2-9481-bc10aca6fb56

</div>

## The Problem

You're running OpenAI, Anthropic, Stripe, Supabase, SendGrid, and a dozen other APIs. Your monthly bill is $2,847 and climbing 340% month-over-month.

**You have no idea which feature is burning money.**

Observability platforms charge $199/mo. API monitoring tools charge $149/mo. Cost management SaaS charges $99/mo.

**burn0 is free. One import. That's it.**

```
burn0 ▸ $4.32 today (47 calls) ── openai: $3.80 · anthropic: $0.52
```

---

## Quick Start

```bash
npm i @burn0/burn0
```

Add one line to your entry file:

```typescript
import "@burn0/burn0"; // Must be first import

import express from "express";
import OpenAI from "openai";
// ... your app runs exactly the same
```

That's it. Costs appear in your terminal:

```
burn0 ▸ $0.47 today (12 calls) ── openai: $0.41 · stripe: $0.06
```

On exit:

```
burn0 ▸ session: $0.47 (12 calls, 4m 22s) ── today: $14.32 ── ~$430/mo
```

### Want full history and dashboards? Add an API key:

```bash
# 1. Sign in with GitHub and create a key
open https://burn0.dev/login
#    → Dashboard → API Keys → Create Key

# 2. Add it to your project
echo 'BURN0_API_KEY=b0_sk_your_key_here' >> .env

# 3. Restart — costs now sync to burn0.dev
```

Now you get a **live event feed**, **cost breakdown by service**, **monthly projections**, and **full request history** — all at [burn0.dev/dashboard](https://burn0## The Problem.dev/dashboard).

> burn0 only syncs metadata (service, model, tokens, cost, latency) — never request/response bodies or your API keys.

---

## How It Compares

|                     | Observability Platform | API Monitoring | Cost Management SaaS | **burn0**              |
| ------------------- | ---------------------- | -------------- | -------------------- | ---------------------- |
| **Price**           | $199/mo                | $149/mo        | $99/mo               | **Free forever**       |
| **Setup**           | SDK + dashboard config | Proxy setup    | Manual tagging       | **One import**         |
| **Latency**         | 5-50ms                 | 10-100ms       | Async                | **<1ms**               |
| **Per-feature**     | Manual instrumentation | No             | Manual               | **`burn0.track()`**    |
| **Works locally**   | No                     | No             | No                   | **Yes**                |
| **Open source**     | No                     | No             | No                   | **MIT Licensed**       |
| **Data leaves app** | Always                 | Always         | Always               | **Only if you opt in** |

**You're spending $526/mo on tools that burn0 replaces for $0.**

---

## CLI

```bash
# Interactive setup wizard
npx burn0 init

# Cost report (last 7 days)
npx burn0 report

# Today only
npx burn0 report --today

# Run any app with tracking (zero code changes)
npx burn0 dev -- node app.js

# Connect to cloud dashboard
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

---

## Feature Attribution

Know exactly which feature burns money:

```typescript
import { track } from "@burn0/burn0";

await track("onboarding", async () => {
  const profile = await ai.generateProfile(user);
  await stripe.createSubscription(user.id);
  await sendWelcomeEmail(user.email);
});
```

```
burn0 ▸ feature "onboarding" ── $0.47/user
         └─ openai     $0.39  (83%)
         └─ stripe     $0.0001 (2%)
         └─ sendgrid   $0.08  (17%)
```

Track per user, per feature, per request. No manual tagging. No dashboards to configure.

---

## 50+ Services Supported

burn0 auto-detects services from hostnames. Zero configuration.

### AI / LLMs

| Service       | Detection                           | Pricing Model     |
| ------------- | ----------------------------------- | ----------------- |
| OpenAI        | `api.openai.com`                    | Per-token (exact) |
| Anthropic     | `api.anthropic.com`                 | Per-token (exact) |
| Google Gemini | `generativelanguage.googleapis.com` | Per-token (exact) |
| Mistral       | `api.mistral.ai`                    | Per-token (exact) |
| Cohere        | `api.cohere.ai`                     | Per-token         |
| Groq          | `api.groq.com`                      | Per-token         |
| Together AI   | `api.together.xyz`                  | Per-token         |
| Perplexity    | `api.perplexity.ai`                 | Per-token         |
| DeepSeek      | `api.deepseek.com`                  | Per-token         |
| Replicate     | `api.replicate.com`                 | Per-second        |
| Fireworks AI  | `api.fireworks.ai`                  | Per-token         |
| AI21 Labs     | `api.ai21.com`                      | Per-token         |
| Pinecone      | `*.pinecone.io`                     | Per-request       |

### Pay-per-use APIs

| Service     | Detection             | Pricing Model   |
| ----------- | --------------------- | --------------- |
| Stripe      | `api.stripe.com`      | Per-transaction |
| PayPal      | `api.paypal.com`      | Per-transaction |
| Plaid       | `*.plaid.com`         | Per-request     |
| SendGrid    | `api.sendgrid.com`    | Per-email       |
| Resend      | `api.resend.com`      | Per-email       |
| Twilio      | `api.twilio.com`      | Per-message     |
| Vonage      | `api.nexmo.com`       | Per-message     |
| Algolia     | `*.algolia.net`       | Per-search      |
| Google Maps | `maps.googleapis.com` | Per-request     |
| Mapbox      | `api.mapbox.com`      | Per-request     |
| Cloudinary  | `api.cloudinary.com`  | Per-transform   |
| Sentry      | `sentry.io`           | Per-event       |
| Segment     | `api.segment.io`      | Per-event       |
| Mixpanel    | `api.mixpanel.com`    | Per-event       |

### Databases & Infrastructure

| Service       | Detection                | Pricing Model  |
| ------------- | ------------------------ | -------------- |
| Supabase      | `*.supabase.co`          | Per-request    |
| PlanetScale   | `*.psdb.cloud`           | Per-request    |
| MongoDB Atlas | `*.mongodb.net`          | Per-request    |
| Upstash       | `*.upstash.io`           | Per-request    |
| Neon          | `*.neon.tech`            | Per-request    |
| Turso         | `*.turso.io`             | Per-request    |
| Firebase      | `*.firebaseio.com`       | Per-request    |
| AWS S3        | `*.s3.amazonaws.com`     | Per-request    |
| AWS Lambda    | `lambda.*.amazonaws.com` | Per-invocation |
| Vercel        | `api.vercel.com`         | Per-request    |

**Unknown APIs are auto-tracked by request count.** Nothing slips through.

---

## How It Works

```
Your app starts
  │
  ├─ import '@burn0/burn0' patches globalThis.fetch + node:http
  │
  ├─ Every outbound HTTP call is intercepted (zero behavior change)
  │
  ├─ Service identified from hostname (api.openai.com → OpenAI)
  │
  ├─ Token counts + costs extracted from response metadata
  │
  └─ Costs displayed in terminal + stored in local ledger
```

1. **Interception is synchronous** — your request goes out immediately
2. **Cost extraction is async** — happens after the response, never blocks
3. **Sub-millisecond overhead** — benchmarked, not estimated
4. **Never reads content** — only extracts metadata: service, model, tokens, status, latency
5. **Never throws** — graceful degradation if anything fails internally
6. **±2% accuracy** — exact token counts from LLM APIs, bundled pricing for SaaS

---

## Two Modes

| Mode                | API Key | What happens                                                                                                  |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| **Local** (default) | No      | Costs in terminal + local ledger. Zero network calls to burn0.                                                |
| **Cloud** (opt-in)  | Yes     | Same as local + events sync to [dashboard](https://burn0.dev/dashboard) for full history and team visibility. |

> **Start local, upgrade when ready.** burn0 works perfectly without an API key. When you want history and dashboards, add a key — it takes 60 seconds. [Get your free API key →](https://burn0.dev/login)

---

## Configuration

| Env Variable        | Default                 | Description                             |
| ------------------- | ----------------------- | --------------------------------------- |
| `BURN0_API_KEY`     | —                       | API key for cloud mode                  |
| `BURN0_API_URL`     | `https://api.burn0.dev` | Backend URL                             |
| `BURN0_DEBUG`       | `false`                 | Enable debug logging                    |
| `BURN0_ENABLE_TEST` | —                       | Set to `1` to enable in `NODE_ENV=test` |

---

## Works With Everything

burn0 works with any Node.js framework. If it makes HTTP calls, burn0 tracks the costs.

```
Express · Next.js · Fastify · Hono · Koa · NestJS · Remix · Nuxt
```

**Requirements:** Node.js >= 18

---

## Frequently Asked Questions

### Does it slow down my API calls?

No. Interception is synchronous but event processing is fully async. burn0 adds sub-millisecond overhead to your API calls.

### Does it send my data anywhere?

By default, no. In local mode, costs are logged to your terminal and stored in a local file. Cloud mode (opt-in) ships only metadata — never request/response bodies.

### How accurate are the cost estimates?

burn0 extracts exact token counts from LLM API responses. For pay-per-use APIs, it uses bundled pricing data. Accuracy is within ±2%.

### Can I use it in production?

Yes. burn0 is designed for production use. It never throws, never adds latency, and gracefully degrades if anything fails internally.

### Is it really free?

Yes. burn0 is MIT licensed and free forever. No API key required for local mode. Cloud features (dashboard, team analytics) are available as a paid tier.

---

## Development

```bash
git clone https://github.com/burn0-dev/burn0.git
cd burn0
npm install
npm run build
npm test
```

---

## Community

| Channel    | Link                                                  |
| ---------- | ----------------------------------------------------- |
| 🌐 Website | [burn0.dev](https://burn0.dev)                        |
| 📖 Docs    | [docs.burn0.dev](https://docs.burn0.dev)              |
| 🐦 Twitter | [@burn0dev](https://twitter.com/burn0dev)             |
| 💻 GitHub  | [burn0-dev/burn0](https://github.com/burn0-dev/burn0) |

---

<div align="center">

**MIT License** · Built by the [burn0](https://burn0.dev) team

⭐ If burn0 saves you money, consider starring the repo.

</div>
