// Seeds realistic LLM traffic straight into the burn0 db (no API keys needed).
// Rows look exactly like captured OpenAI/Anthropic/Gemini calls: real model
// names, token counts, computed costs, and full Q&A payloads for the Debug view.
import { loadConfig, openDatabase, ensureProject, insertRows, loadPricing, computeCost } from '@burn0/core'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QA = [
  ['Summarize the key ideas of the CAP theorem in two sentences.',
    'The CAP theorem states that a distributed system can guarantee at most two of consistency, availability, and partition tolerance at any moment. In practice, since network partitions are unavoidable, designers choose between consistency and availability during a partition.'],
  ['Write a SQL query to find the top 5 customers by total order value.',
    'SELECT c.id, c.name, SUM(o.total) AS total_value\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.id, c.name\nORDER BY total_value DESC\nLIMIT 5;'],
  ['Explain the difference between optimistic and pessimistic locking.',
    'Pessimistic locking acquires a lock before reading or writing, blocking other transactions until released — safe but slow under contention. Optimistic locking lets transactions proceed without locks and validates at commit time (usually via a version column), retrying when a conflict is detected.'],
  ['What are good strategies to reduce LLM token costs in production?',
    'Cache aggressively (both exact-match response caches and provider prompt caching), trim conversation history with summarization, route simple queries to smaller models, batch offline work, and set per-feature token budgets with monitoring so regressions surface immediately.'],
  ['Refactor this callback code to async/await: fs.readFile(p, (e, d) => {...})',
    "Use the promises API:\n\nimport { readFile } from 'node:fs/promises'\n\nconst data = await readFile(p, 'utf8')\n\nWrap call sites in try/catch to handle errors that the callback previously received as its first argument."],
  ['Give me a one-line description for a local-first API observability tool.',
    'Zero-code, local-first observability that captures every API and LLM call your app makes — costs, latency, and payloads — without your data ever leaving the machine.'],
]

function openaiRow(now, minutesAgo, model, [q, a], usage, pricing) {
  const cost = computeCost(pricing, 'openai', model, usage)
  return {
    startedAt: now - minutesAgo * 60_000,
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    hostname: 'api.openai.com',
    status: 200,
    firstByteMs: 180 + Math.floor(minutesAgo % 5) * 60,
    latencyMs: 900 + (minutesAgo % 7) * 350,
    reqBytes: 400, resBytes: 900,
    reqHeaders: { 'content-type': 'application/json', authorization: '[redacted]' },
    resHeaders: { 'content-type': 'application/json' },
    reqBody: JSON.stringify({ model, messages: [
      { role: 'system', content: 'You are a concise senior engineer.' },
      { role: 'user', content: q },
    ] }, null, 0),
    resBody: JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: a }, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.tokensIn, completion_tokens: usage.tokensOut,
        prompt_tokens_details: { cached_tokens: usage.tokensCached ?? 0 } } }),
    stackSnippet: 'at askModel (src/services/ai.ts:42)\nat handleChat (src/routes/chat.ts:18)',
    tags: { feature: 'chat' },
    estimated: false,
    entity: 'OpenAI', entityClass: 'llm', provider: 'openai',
    normalizedEndpoint: '/v1/chat/completions', model,
    tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, tokensCached: usage.tokensCached ?? null,
    costUsd: cost,
    reqTruncated: false, resTruncated: false,
  }
}

function anthropicRow(now, minutesAgo, [q, a], usage, pricing) {
  const model = 'claude-sonnet-4-5'
  const cost = computeCost(pricing, 'anthropic', model, usage)
  return {
    ...openaiRow(now, minutesAgo, model, [q, a], usage, pricing),
    url: 'https://api.anthropic.com/v1/messages',
    hostname: 'api.anthropic.com',
    entity: 'Anthropic', provider: 'anthropic',
    normalizedEndpoint: '/v1/messages', model,
    reqBody: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: q }] }),
    resBody: JSON.stringify({ model, content: [{ type: 'text', text: a }],
      usage: { input_tokens: usage.tokensIn, output_tokens: usage.tokensOut, cache_read_input_tokens: usage.tokensCached ?? 0 } }),
    costUsd: cost,
  }
}

function geminiRow(now, minutesAgo, [q, a], usage, pricing) {
  const model = 'gemini-2.0-flash'
  const cost = computeCost(pricing, 'gemini', model, usage)
  return {
    ...openaiRow(now, minutesAgo, model, [q, a], usage, pricing),
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    hostname: 'generativelanguage.googleapis.com',
    entity: 'Gemini', provider: 'gemini',
    normalizedEndpoint: `/v1beta/models/${model}:generateContent`, model,
    reqBody: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: q }] }] }),
    resBody: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: a }] } }],
      usageMetadata: { promptTokenCount: usage.tokensIn, candidatesTokenCount: usage.tokensOut }, modelVersion: model }),
    costUsd: cost,
  }
}

const cfg = loadConfig(process.cwd(), process.env)
const db = openDatabase(cfg.dbPath)
const projectId = ensureProject(db, { name: 'burn0-test', rootPath: process.cwd(), gitRoot: null })
const pricing = await loadPricing({ cacheDir: join(homedir(), '.burn0'), ttlHours: 24 })
const now = Date.now()

const rows = [
  openaiRow(now, 2,   'gpt-4o',      QA[0], { tokensIn: 1240, tokensOut: 96,  tokensCached: 512 }, pricing),
  openaiRow(now, 9,   'gpt-4o',      QA[1], { tokensIn: 830,  tokensOut: 141 }, pricing),
  openaiRow(now, 16,  'gpt-4o-mini', QA[2], { tokensIn: 610,  tokensOut: 188 }, pricing),
  openaiRow(now, 31,  'gpt-4o-mini', QA[5], { tokensIn: 240,  tokensOut: 54 }, pricing),
  anthropicRow(now, 5,  QA[3], { tokensIn: 2100, tokensOut: 260, tokensCached: 1400 }, pricing),
  anthropicRow(now, 22, QA[4], { tokensIn: 480,  tokensOut: 130 }, pricing),
  geminiRow(now, 12, QA[5], { tokensIn: 190, tokensOut: 61 }, pricing),
  // yesterday + last week for the 7d/30d windows
  openaiRow(now, 60 * 26,      'gpt-4o',      QA[2], { tokensIn: 1500, tokensOut: 220 }, pricing),
  anthropicRow(now, 60 * 30,   QA[0], { tokensIn: 900, tokensOut: 180 }, pricing),
  openaiRow(now, 60 * 24 * 5,  'gpt-4o-mini', QA[1], { tokensIn: 700, tokensOut: 90 }, pricing),
]

insertRows(db, projectId, rows, true)
const spend = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0)
console.log(`seeded ${rows.length} LLM calls (OpenAI/Anthropic/Gemini) — total cost $${spend.toFixed(4)}`)
console.log('open the dashboard: node ../cli/dist/index.mjs  → LLM tab, enter a row for input/output')
db.close()
