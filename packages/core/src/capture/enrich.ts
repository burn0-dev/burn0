import { detectEntity, normalizeEndpoint } from '../entities/index.js'
import { redactHeaders, redactBody } from '../storage/redact.js'
import { extractModel, parseUsage, parseSSEUsage, normalizeUsage } from '../llm/parse.js'
import { parseToolCalls, parseToolResults } from '../llm/tools.js'
import { openToolTrace, closeToolTrace } from '../context/trace.js'
import { computeCost, type PricingTable } from '../pricing/index.js'
import type { CaptureEvent, EnrichedRow } from '../types.js'

export interface EnrichOpts {
  pricing: PricingTable
  bodyCapBytes: number
  redactDisabled: boolean
  extraRedactHeaders: string[]
  isSSE: boolean
}

export function enrich(event: CaptureEvent, opts: EnrichOpts): EnrichedRow {
  const { entity, entityClass, provider } = detectEntity(event.hostname)
  let pathname = '/'
  try { pathname = new URL(event.url).pathname } catch {}

  // Model/usage extraction is a pure JSON-shape heuristic (looks for
  // OpenAI/Anthropic/Gemini-style `model`/`usage` fields) and is
  // intentionally NOT gated on entityClass: many teams route LLM calls
  // through internal gateways or self-hosted proxies whose hostname never
  // matches the known-provider list in entities/hosts.ts, and those calls
  // still deserve token/cost tracking. Only cost computation requires a
  // recognized `provider` (below), since pricing tables are keyed by it.
  let model: string | null = null
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let tokensCached: number | null = null
  let costUsd: number | null = null
  model = extractModel(event.reqBody, pathname, opts.isSSE ? null : event.resBody)
  const rawUsage = opts.isSSE ? parseSSEUsage(event.resBody ?? '') : parseUsage(event.resBody)
  const usage = rawUsage ? normalizeUsage(rawUsage) : null
  let tokensCacheWrite: number | null = null
  if (usage) {
    tokensIn = usage.tokensIn
    tokensOut = usage.tokensOut
    tokensCached = usage.tokensCached
    tokensCacheWrite = usage.tokensCacheWrite
    // Not gated on `provider`: a self-hosted gateway has provider null, and the
    // bare-name lookup is the correct answer for it. The old gate discarded the
    // cost of every gateway-routed LLM call outright.
    if (model) costUsd = computeCost(opts.pricing, provider, model, usage)
  }

  // §8: extraction runs here, at insert, and *before* redaction — payloads die
  // at 7 days while trace structure lives 30, so a lazy read would lose tool
  // history for two-thirds of retained traces, and a redacted body gives wrong
  // arguments. Entirely best-effort: nothing here may affect the row.
  try { recordToolCalls(event) } catch {}

  const [reqBody, reqTruncated] = cap(event.reqBody, opts.bodyCapBytes)
  const [resBody, resTruncated] = cap(event.resBody, opts.bodyCapBytes)

  return {
    ...event,
    reqHeaders: opts.redactDisabled ? event.reqHeaders : redactHeaders(event.reqHeaders, opts.extraRedactHeaders),
    resHeaders: opts.redactDisabled ? event.resHeaders : redactHeaders(event.resHeaders, opts.extraRedactHeaders),
    reqBody: opts.redactDisabled ? reqBody : redactBody(reqBody),
    resBody: opts.redactDisabled ? resBody : redactBody(resBody),
    entity, entityClass, provider,
    normalizedEndpoint: normalizeEndpoint(pathname),
    model, tokensIn, tokensOut, tokensCached, tokensCacheWrite, costUsd,
    reqTruncated, resTruncated,
  }
}

/** Open a tool node for every call this response declared, and close the ones
 *  whose results this request carried. Both halves are exact — names, arguments,
 *  results and errors all come from payloads burn0 already has. Only the nesting
 *  of downstream HTTP calls under a tool is inferred, and that happens at read
 *  time from the window recorded here. */
function recordToolCalls(event: CaptureEvent): void {
  const parent = event.trace?.localId
  if (parent == null) return

  // Results first: this request is the closing bracket of an earlier window.
  for (const r of parseToolResults(event.reqBody)) {
    closeToolTrace({ parentLocalId: parent, toolId: r.id, result: r.result, isError: r.isError, now: event.startedAt })
  }

  const declared = parseToolCalls(event.resBody)
  if (declared.length === 0) return
  // The window opens when the declaring response completed — the tool cannot
  // have started running before the app was told to run it.
  const now = event.startedAt + (event.latencyMs ?? 0)
  // Several tools declared in one turn run concurrently, so their windows
  // overlap and no candidate can be assigned to one of them honestly. Marked
  // `turn` so the UI can show them as siblings rather than present a guess as
  // certainty (§8.4).
  const attribution = declared.length > 1 ? 'turn' : 'window'
  for (const c of declared) {
    openToolTrace({ parentLocalId: parent, toolId: c.id, name: c.name, args: c.args, attribution, now })
  }
}

function cap(body: string | null, max: number): [string | null, boolean] {
  if (body == null || body.length <= max) return [body, false]
  return [body.slice(0, max), true]
}
