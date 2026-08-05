import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import {
  query, loadConfig, redactQueryString, detectEntity,
  type StorageDriver, type TraceTreeNode,
} from '@burn0/core'
import { theme, statusColor } from '../theme.js'
import { G, visWidth, padCell } from '../glyphs.js'
import { extractExchange, type Exchange } from '../llm-io.js'
import { tokenBreakdown, type TokenFacts } from '../token-block.js'
import { fmtUsd, fmtNum, fmtMs, fmtTime, fmtBytes } from '../../format.js'
import type { DisplayRow } from '../tree-model.js'

/** The detail pane: one card per row type, chat-style for LLM turns (spec §3).
 *
 *  Everything below builds a `Line[]` and hands it to one renderer. That is not
 *  ceremony — the pane's whole contract is "how many lines, in what order, and
 *  which ones survive a 36-column terminal", and none of that is inspectable
 *  once it has been scattered across JSX. */

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

export interface Line {
  text?: string
  /** A stats strip: segments joined by a dim ` · `, each colored on its own. */
  segs?: Line[]
  color?: string
  dim?: boolean
  bold?: boolean
  /** Elaboration: shed before the card truncates its tail. The token block's
   *  fresh/cached/written lines are marked; an `issues` line never is. */
  optional?: boolean
}

const L = (text: string, o: Omit<Line, 'text' | 'segs'> = {}): Line => ({ text, ...o })

// ---------------------------------------------------------------------------
// Widths, caps, budgets (spec §3)
// ---------------------------------------------------------------------------

// Nothing here is a width THRESHOLD. Spec §3 describes the strip's shed order
// ("below 44 inner cols drop `first byte`, then start time") and §3's composite
// lines split the same way; both are implemented by measuring the composed line
// against the width it actually has. A constant that predicts the fit instead
// of checking it is wrong on every width it did not anticipate.

const ENDPOINT_CAP = 3
const QUERY_CAP = 2
const RESPONSE_CAP = 3
const RESPONSE_CAP_ERR = 6
const TOOL_IO_CAP = 6
const STEPS_CAP = 24
/** Pretty-printing a megabyte of JSON at the 1s poll is the one thing this pane
 *  can do that a user would feel. Past this, args render as stored. */
const PRETTY_MAX_BYTES = 16 * 1024

const USER_CAP = 3
const RESULTS_CAP = 3
const ASSISTANT_CAP = 8
const TOOLS_CAP = 4

const DAY_MS = 86_400_000

/** Reader-side retention — what THIS machine's config says payloads live for.
 *  It is the only honest yardstick for "expired": the writer's config is not
 *  recorded per row, and the sweep that deleted the payload ran under the
 *  reader's rules anyway. */
let cachedRetention: { payloads: number; metadata: number } | null = null
function readerRetention(): { payloads: number; metadata: number } {
  if (cachedRetention == null) {
    try { cachedRetention = loadConfig(process.cwd()).retentionDays } catch { cachedRetention = { payloads: 7, metadata: 30 } }
  }
  return cachedRetention
}

// ---------------------------------------------------------------------------
// Text fitting
// ---------------------------------------------------------------------------

/** Truncate to `w` display cells with a trailing `…`; never pads. Newlines and
 *  tabs flatten to a space — runs of spaces do NOT collapse, because the label
 *  columns in the token block and the root card's `slowest`/`issues` rows are
 *  made of exactly those runs. */
function clip(s: string, w: number): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ')
  if (w <= 0) return ''
  return visWidth(flat) <= w ? flat : padCell(flat, w).trimEnd()
}

/** `{head}{name}{tail}` in `w` cells with the NAME absorbing all truncation —
 *  the tree's suffix-reservation rule (spec §2.1) applied to prose lines: a
 *  clipped tool name is an inconvenience, a clipped `18.3 KB` is a lie. */
function composeReserved(head: string, name: string, tail: string, w: number): string {
  const budget = w - visWidth(head) - visWidth(tail)
  if (budget <= 0) return clip(head + name + tail, w)
  return head + clip(name, budget) + tail
}

/** Greedy wrap on whitespace; hard-splits a token longer than the width. */
function wrapWords(s: string, w: number): string[] {
  const out: string[] = []
  for (const para of s.split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) { if (para.trim() === '' && out.length > 0) continue; continue }
    let line = ''
    for (const word of words) {
      if (line === '') { line = word } else if (visWidth(`${line} ${word}`) <= w) { line = `${line} ${word}` } else { out.push(line); line = word }
      while (visWidth(line) > w) { out.push(padCell(line, w).trimEnd()); line = '' }
    }
    if (line !== '') out.push(line)
  }
  return out.length > 0 ? out : ['']
}

/** Wrap on a structural separator, keeping it at the head of the continuation
 *  line: `/API_SALES_ORDER_SRV` stays whole, `12× GET · sap.com` breaks before
 *  the `·`. Word-wrapping a URL path shears identifiers mid-token, which is
 *  exactly the truncation the tree spends its budget rules avoiding. */
function wrapOn(s: string, sep: string, w: number, lead = ''): string[] {
  const parts = s.split(sep)
  const tokens: string[] = []
  parts.forEach((p, i) => {
    if (i === 0) { if (p !== '') tokens.push(p) } else tokens.push(sep + p)
  })
  if (tokens.length === 0) return ['']
  const out: string[] = []
  let line = lead
  for (const t of tokens) {
    if (line === '' || line === lead) {
      line = line + t
    } else if (visWidth(line + t) <= w) {
      line += t
    } else {
      out.push(line)
      line = t
    }
    if (visWidth(line) > w) { out.push(clip(line, w)); line = '' }
  }
  if (line !== '') out.push(line)
  return out.length > 0 ? out : ['']
}

/** Keep `cap` lines; the overflow is stated, never silently dropped — except at
 *  a cap of one, where the `+N more` marker would consume the only line there
 *  is and leave a label sitting over a count. One line of the actual message
 *  beats an exact number of lines you cannot see. */
function capLines(lines: string[], cap: number, o: { dim?: boolean; color?: string } = {}): Line[] {
  if (cap <= 0) return []
  if (lines.length <= cap) return lines.map((t) => L(t, o))
  if (cap === 1) return [L(lines[0], o)]
  const kept = lines.slice(0, cap - 1).map((t) => L(t, o))
  kept.push(L(`+${lines.length - (cap - 1)} more`, { dim: true }))
  return kept
}

// ---------------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------------

const SEP = ' · '

function segsWidth(segs: Line[]): number {
  return segs.reduce((n, s) => n + visWidth(s.text ?? ''), 0)
    + Math.max(0, segs.length - 1) * visWidth(SEP)
}

/** The strip, as segments, shed by MEASURED fit — a width threshold only
 *  predicts whether the line fits; it does not check. Getting that wrong shears
 *  the line from the right under `wrap="truncate"`, and the right is where the
 *  cost lives, so `$0.0203` renders as `$0.0…` on exactly the widths a 140-col
 *  terminal produces. Shed order is the spec's (`first byte`, then start time);
 *  status, duration, cost and tokens are never shed — if they alone still
 *  overflow, `stripLines` wraps them onto a second line rather than cut one.
 *
 *  Duration carries NO color: red means failure in this screen and nothing
 *  else, so `latencyColor` never touches it (spec §2.4). */
export function buildStrip(o: {
  lead: Line
  durationMs: number | null
  firstByteMs?: number | null
  startedAt?: number | null
  /** Never dropped — cost and tokens are the reason the pane exists. */
  tail?: Line[]
  inner: number
}): Line[] {
  const mandatory: Line[] = [o.lead, { text: fmtMs(o.durationMs) }]
  const tail = o.tail ?? []
  const optional: Line[] = []
  if (o.firstByteMs != null) optional.push({ text: `first byte ${fmtMs(o.firstByteMs)}`, dim: true })
  if (o.startedAt != null) optional.push({ text: fmtTime(o.startedAt), dim: true })

  const assemble = () => [...mandatory, ...optional, ...tail]
  while (optional.length > 0 && segsWidth(assemble()) > o.inner) optional.shift()
  return assemble()
}

/** Pack strip segments into as many lines as they need. The mandatory
 *  segments outlive every width, so the only honest answer below their combined
 *  width is a second line. */
function stripLines(segs: Line[], inner: number): Line[] {
  const out: Line[] = []
  let cur: Line[] = []
  let w = 0
  for (const s of segs) {
    const sw = visWidth(s.text ?? '')
    if (cur.length === 0) { cur = [s]; w = sw; continue }
    if (w + visWidth(SEP) + sw <= inner) { cur.push(s); w += visWidth(SEP) + sw } else { out.push({ segs: cur }); cur = [s]; w = sw }
  }
  if (cur.length > 0) out.push({ segs: cur })
  return out
}

/** Segments on one line if they fit, one line each if they do not — measured,
 *  never thresholded (spec §3's "host/bytes split lines"). */
function measuredLines(parts: string[], inner: number, o: Omit<Line, 'text' | 'segs'> = {}): Line[] {
  const joined = parts.join(SEP)
  if (visWidth(joined) <= inner) return [L(joined, o)]
  return parts.map((p) => L(clip(p, inner), o))
}

function statusSeg(status: number | null): Line {
  return { text: status == null ? '—' : String(status), color: statusColor(status) }
}

// ---------------------------------------------------------------------------
// Token block (spec §1.3)
// ---------------------------------------------------------------------------

/** Lays the shared fresh/cached/written breakdown (`../token-block.js`) out
 *  as clipped, optional `Line`s — the card's own concerns (width, dimming,
 *  which lines yield first when the pane is short) stay here; the numbers
 *  themselves are computed once, in the module every screen shares. */
function tokenBlock(n: TokenFacts, inner: number): Line[] {
  const b = tokenBreakdown(n)
  const out = [L(clip(b.head, inner))]
  const sub = (label: string, value: string) =>
    L(clip(`  ${label.padEnd(8)}${value}`, inner), { dim: true, optional: true })

  if (b.fresh != null) out.push(sub('fresh', b.fresh))
  if (b.cached != null) out.push(sub('cached', b.cached))
  if (b.written != null) out.push(sub('written', b.written))
  return out
}

// ---------------------------------------------------------------------------
// LLM section budget (spec §3, the deterministic shrink order)
// ---------------------------------------------------------------------------

export interface SectionCaps {
  marker: number
  system: number
  user: number
  results: number
  assistant: number
  tools: number
}

const capTotal = (c: SectionCaps): number =>
  c.marker + c.system + c.user + c.results + c.assistant + c.tools

/** assistant→4, user→2, drop system, results→1, tools→2, drop marker,
 *  assistant→2, user→1 — applied one step at a time, stopping the moment the
 *  caps fit. Order is the spec's; it is deterministic so the same trace never
 *  renders two different ways at the same size. */
const SHRINK: Array<(c: SectionCaps) => void> = [
  (c) => { c.assistant = Math.min(c.assistant, 4) },
  (c) => { c.user = Math.min(c.user, 2) },
  (c) => { c.system = 0 },
  (c) => { c.results = Math.min(c.results, 1) },
  (c) => { c.tools = Math.min(c.tools, 2) },
  (c) => { c.marker = 0 },
  (c) => { c.assistant = Math.min(c.assistant, 2) },
  (c) => { c.user = Math.min(c.user, 1) },
]

export function fitSections(caps: SectionCaps, budget: number): SectionCaps {
  const c = { ...caps }
  for (const step of SHRINK) {
    if (capTotal(c) <= budget) return c
    step(c)
  }
  // Past the end of the spec's order the pane is smaller than any honest
  // rendering of the exchange. Shed whole sections from the least load-bearing
  // end rather than paint over the border.
  for (const k of ['tools', 'results', 'assistant', 'user'] as const) {
    while (capTotal(c) > budget && c[k] > 0) c[k] -= 1
  }
  return c
}

// ---------------------------------------------------------------------------
// Degraded payload states (spec §3 table)
// ---------------------------------------------------------------------------

type Retention = { payloads: number; metadata: number }

/** "expired" and "never captured" look identical in the database — one absent
 *  row either way. Row age against the reader's retention is the only evidence
 *  there is, so it is what the wording keys on. `what` is per-card on purpose:
 *  an LLM row lost a conversation, an API row lost a request and a response,
 *  a tool row lost its args and result. */
function missingPayloadLines(
  what: string, startedAt: number, r: Retention, inner: number, now: number,
): Line[] {
  // These strings are the state's definition, so they wrap rather than clip —
  // `capturePayloa…` names nothing and `(payload retention: 7 d…` is a number
  // the reader has to guess at.
  const state = (s: string) => wrapOn(s, ' — ', inner).flatMap((l) => wrapWords(l, inner))
    .map((t) => L(t, { dim: true }))
  if (now - startedAt > r.payloads * DAY_MS) {
    return [
      ...state(`${what} expired (payload retention: ${r.payloads} days)`),
      ...state(`structure and status remain for ${r.metadata} days`),
    ]
  }
  return state('payloads not captured (capturePayloads: false) — stats only')
}

const SSE_START = /^\s*(data:|event:)/

function unparseable(body: string | null): boolean {
  if (body == null) return false
  if (SSE_START.test(body)) return false
  try { JSON.parse(body); return false } catch { return true }
}

/** Two raw lines — enough to recognise an HTML error page or a proxy banner,
 *  short enough that the card is still a card. */
function rawPreview(body: string, inner: number): Line[] {
  return body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2)
    .map((l) => L(clip(l, inner), { dim: true }))
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function titleLine(text: string, color: string | undefined, inner: number): Line {
  return L(clip(text, inner), { color, bold: true })
}

function llmCard(o: {
  node: TraceTreeNode; detail: any; ex: Exchange | null
  inner: number; budget: number; retention: Retention; now: number
}): Line[] {
  const { node, detail, ex, inner, budget, retention, now } = o

  // Exactly one side reported = the cost is a floor, not a figure (spec §1.3).
  const partial = node.pricedCalls > 0 && ((node.tokensIn == null) !== (node.tokensOut == null))
  const cost: Line = node.pricedCalls > 0
    ? { text: `${partial ? '~' : ''}${fmtUsd(node.costUsd)}`, color: theme.cost }
    : { text: '— unpriced', dim: true }

  const head: Line[] = [
    titleLine(`${G.llm} ${node.model ?? node.label}`, theme.entityLlm, inner),
    ...stripLines(buildStrip({
      lead: statusSeg(node.status),
      durationMs: node.durationMs,
      firstByteMs: detail?.firstByteMs ?? null,
      startedAt: node.startedAt,
      tail: [cost],
      inner,
    }), inner),
    ...(partial ? [L(clip('partial usage — true cost is at least this', inner), { dim: true })] : []),
  ]

  const tok = tokenBlock(node, inner)
  const foot: Line[] = detail?.payload != null
    ? [L('⏎ full payload', { dim: true })]
    : detail == null
      ? [L(clip('request row is gone — pruned by retention', inner), { dim: true })]
      : missingPayloadLines('conversation', node.startedAt, retention, inner, now)

  // Allocation, in the order things are worth keeping. The conversation gets a
  // floor of one labelled line each way FIRST; the token block's fresh/cached/
  // written detail and the `⏎` affordance are elaboration and yield to it. The
  // block's own head line is never negotiable — the strip's tokens never drop.
  const floor = Math.min(4, llmBodyExtent(o))
  let spare = budget - head.length - 1 - floor
  const tokDetail = Math.max(0, Math.min(tok.length - 1, spare))
  spare -= tokDetail
  const showFoot = spare >= foot.length
  const bodyBudget = budget - head.length - 1 - tokDetail - (showFoot ? foot.length : 0)

  return [
    ...head,
    ...tok.slice(0, 1 + tokDetail),
    ...llmBody({ ...o, budget: Math.max(0, bodyBudget) }),
    ...(showFoot ? foot : []),
  ]
}

/** How many lines the conversation could use if nothing were in its way — the
 *  floor is capped by it so an exchange with no assistant text does not reserve
 *  room for one. */
function llmBodyExtent(o: { ex: Exchange | null; detail: any }): number {
  const { ex, detail } = o
  if (detail?.payload == null || ex == null) return 0
  if (!ex.parsed) return 3
  return (ex.lastUserText ? 2 : 0) + (ex.assistantText ? 2 : 0)
    + (ex.toolResults.length > 0 ? 1 : 0) + (ex.toolCalls.length > 0 ? 1 : 0)
}

/** The conversation itself: earlier-messages marker, system head, USER,
 *  TOOL RESULT lines, ASSISTANT, `→ tool(args…)` lines. */
function llmBody(o: {
  node: TraceTreeNode; detail: any; ex: Exchange | null
  inner: number; budget: number; retention: Retention; now: number
}): Line[] {
  const { detail, ex, inner, budget } = o
  if (detail == null || detail.payload == null || ex == null) return []

  if (!ex.parsed) {
    const bad = unparseable(detail.payload.reqBody) ? detail.payload.reqBody : detail.payload.resBody
    return [
      L(clip('could not parse the stored payload as JSON — showing it raw', inner), { color: theme.warn }),
      ...rawPreview(String(bad ?? ''), inner),
    ].slice(0, Math.max(1, budget))
  }

  const markerText = [
    ex.earlierCount > 0 ? `${G.elide} ${fmtNum(ex.earlierCount)} earlier message${ex.earlierCount === 1 ? '' : 's'}` : '',
    ex.systemChars > 0 ? `system ${fmtNum(ex.systemChars)} chars` : '',
  ].filter(Boolean).join(' · ')
  const markerLines = markerText ? [markerText] : []
  const systemLines = ex.systemFirstLine ? [`  ${ex.systemFirstLine}`] : []
  const userLines = ex.lastUserText ? wrapWords(ex.lastUserText, inner - 2).map((t) => `  ${t}`) : []
  const resultLines = ex.toolResults.map((r) => composeReserved(
    `TOOL RESULT ${r.isError ? '✗' : '✓'} `, r.name ?? '—', ` · ${fmtBytes(r.bytes)}`, inner))
  const assistantLines = ex.assistantText ? wrapWords(ex.assistantText, inner - 2).map((t) => `  ${t}`) : []
  const toolLines = ex.toolCalls.map((c) => clip(`→ ${c.name}(${c.args ?? ''})`, inner))

  const labels = (userLines.length > 0 ? 1 : 0) + (assistantLines.length > 0 ? 1 : 0)
  const caps = fitSections({
    marker: markerLines.length,
    system: systemLines.length,
    user: Math.min(userLines.length, USER_CAP),
    results: Math.min(resultLines.length, RESULTS_CAP),
    assistant: Math.min(assistantLines.length, ASSISTANT_CAP),
    tools: Math.min(toolLines.length, TOOLS_CAP),
    // The floor lives in the allocator now (`llmCard`), so this is exact
    // arithmetic: whatever the caller reserved is what gets spent.
  }, Math.max(0, budget - labels))

  const out: Line[] = []
  out.push(...capLines(markerLines, caps.marker, { dim: true }).map((l) => ({ ...l, text: clip(l.text!, inner) })))
  out.push(...capLines(systemLines, caps.system, { dim: true }).map((l) => ({ ...l, text: clip(l.text!, inner) })))
  if (caps.user > 0 && userLines.length > 0) {
    out.push(L('USER', { dim: true, bold: true }))
    out.push(...capLines(userLines, caps.user))
  }
  out.push(...capLines(resultLines, caps.results, { dim: true }))
  if (caps.assistant > 0 && assistantLines.length > 0) {
    out.push(L('ASSISTANT', { dim: true, bold: true }))
    out.push(...capLines(assistantLines, caps.assistant))
  }
  out.push(...capLines(toolLines, caps.tools, { color: theme.model }))

  // Only when the request side is empty of EVERYTHING. A tool-result-only
  // follow-up turn legitimately has no user text, and the TOOL RESULT line
  // above already says what that turn was; announcing the absence there would
  // be noise on the most common row in an agent loop.
  if (ex.lastUserText == null && ex.toolResults.length === 0 && markerLines.length === 0) {
    out.push(L(clip('no user message in this request', inner), { dim: true }))
  }
  // The §8.1 bug's tombstone: a response with neither text nor calls says so.
  if (ex.assistantText == null && ex.toolCalls.length === 0) {
    out.push(L(clip('no text and no tool calls in response', inner), { dim: true }))
  }
  return out
}

function toolCard(o: {
  node: TraceTreeNode; io: { args: string | null; result: string | null; truncated: boolean } | null
  inner: number; budget: number; retention: Retention; now: number
}): Line[] {
  const { node, io, inner, retention, now } = o
  const status = node.toolStatus ?? 'running'
  const statusLine: Line = {
    text: status,
    color: status === 'error' ? theme.err : status === 'unresolved' ? theme.warn
      : status === 'ok' ? theme.ok : undefined,
    dim: status === 'running',
  }
  const out: Line[] = [titleLine(`${G.tool} ${node.label}`, theme.model, inner)]
  out.push(...stripLines(
    buildStrip({ lead: statusLine, durationMs: node.durationMs, startedAt: node.startedAt, inner }), inner))

  const attribution = node.attribution === 'exact' ? 'attribution exact (withTrace)'
    : node.attribution === 'window' ? 'attribution window (inferred)'
      : node.attribution === 'turn' ? 'attribution turn — parallel tools; calls shown at turn level'
        : null
  if (attribution != null) out.push(...wrapOn(attribution, ' · ', inner).map((t) => L(t, { dim: true })))

  const rollup = node.pricedCalls > 0
    ? `beneath it: ${fmtNum(node.calls)} call${node.calls === 1 ? '' : 's'} · ${fmtUsd(node.costUsd)}`
    : `beneath it: ${fmtNum(node.calls)} call${node.calls === 1 ? '' : 's'}`
  out.push(...wrapOn(rollup, ' · ', inner).map((t) => L(t)))
  if (node.tokenCalls > 0) out.push(...tokenBlock(node, inner))
  if (node.incomplete) out.push(L(clip('⚠ incomplete — the tool never closed', inner), { color: theme.warn }))

  if (status === 'unresolved') {
    // Broken on the dash, not on spaces: the two halves are a claim and its
    // reason, and half a reason on its own line reads as a different sentence.
    out.push(...wrapOn('result never returned to the model — window closed at trace end', ' — ', inner)
      .map((t) => L(t, { color: theme.warn })))
  }

  if (io == null) {
    // A tool that never resolved has no result to have expired — the sentence
    // above already says why. Only a CLOSED tool's missing I/O is evidence of
    // retention or of capture being off.
    if (status === 'unresolved' || status === 'running') return out
    out.push(...missingPayloadLines('args & result', node.startedAt, retention, inner, now))
    return out
  }
  if (io.args != null) {
    out.push(L('ARGS', { dim: true, bold: true }))
    out.push(...capLines(bodyLines(io.args, inner, true), TOOL_IO_CAP))
  }
  if (io.result != null) {
    out.push(L('RESULT', { dim: true, bold: true }))
    out.push(...capLines(bodyLines(io.result, inner, false), TOOL_IO_CAP))
  }
  if (io.truncated) out.push(L(clip('[truncated at capture]', inner), { dim: true }))
  return out
}

/** ARGS pretty-print; RESULT as stored. Redacted bodies are rendered exactly as
 *  they were stored — the pane never tries to reconstruct what capture hid. */
function bodyLines(body: string, inner: number, pretty: boolean): string[] {
  let text = body
  if (pretty && Buffer.byteLength(body) <= PRETTY_MAX_BYTES) {
    try { text = JSON.stringify(JSON.parse(body), null, 2) } catch { text = body }
  }
  return text.split('\n').flatMap((l) => (visWidth(l) <= inner ? [l] : [clip(l, inner)]))
}

function apiCard(o: {
  node: TraceTreeNode; detail: any; inner: number; retention: Retention; now: number
}): Line[] {
  const { node, detail, inner, retention, now } = o
  const method = node.method ?? detail?.method ?? ''
  // The verb belongs to the endpoint line below, where it prefixes the path it
  // acted on; repeating it in the title says it twice and identifies nothing.
  const out: Line[] = [titleLine(`${G.api} ${detail?.entity ?? entityOf(node)}`.trim(), undefined, inner)]

  const { path, queryString } = splitUrl(detail?.url ?? null, node)
  out.push(...capLines(wrapOn(path, '/', inner, `${method} `), ENDPOINT_CAP))
  if (queryString) {
    out.push(...capLines(wrapOn(redactQueryString(decodeQuery(queryString)), '&', inner), QUERY_CAP, { dim: true }))
  }

  out.push(...stripLines(buildStrip({
    lead: statusSeg(node.status),
    durationMs: node.durationMs,
    firstByteMs: detail?.firstByteMs ?? null,
    startedAt: node.startedAt,
    inner,
  }), inner))

  // Measured, not thresholded: a 40-character tenant hostname pushes the byte
  // counts off the end at widths a constant would have called wide enough, and
  // `4.0 KB i` is not a byte count.
  const host = node.hostname ?? ''
  const bytes = `${fmtBytes(node.reqBytes)} out / ${fmtBytes(node.resBytes)} in`
  out.push(...measuredLines([host, bytes], inner, { dim: true }))

  if (node.status == null) {
    out.push(L(clip('no response — network failure', inner), { color: theme.err }))
  } else if (detail?.payload == null) {
    out.push(...(detail == null
      ? [L(clip('request row is gone — pruned by retention', inner), { dim: true })]
      : missingPayloadLines('request & response', node.startedAt, retention, inner, now)))
  } else {
    const failed = node.status >= 400
    out.push(L('RESPONSE', { dim: true, bold: true, color: failed ? theme.err : undefined }))
    const body = detail.payload.resBody
    out.push(...(body
      ? capLines(bodyLines(String(body), inner, false), failed ? RESPONSE_CAP_ERR : RESPONSE_CAP)
      : [L(clip('empty response body', inner), { dim: true })]))
  }

  if (detail?.payload?.stackSnippet) {
    out.push(L(clip(`called from ${detail.payload.stackSnippet}`, inner), { dim: true }))
  }
  if (detail?.payload != null) out.push(L('⏎ full payload', { dim: true }))
  return out
}

/** The stored URL is the only place a query string survives — `normalized_
 *  endpoint` deliberately drops it, and the tree never shows one. */
function splitUrl(url: string | null, node: TraceTreeNode): { path: string; queryString: string } {
  const fallback = node.method && node.label.startsWith(`${node.method} `)
    ? node.label.slice(node.method.length + 1) : node.label
  if (!url) return { path: fallback, queryString: '' }
  try {
    const u = new URL(url)
    return { path: u.pathname, queryString: u.search.replace(/^\?/, '') }
  } catch {
    const q = url.indexOf('?')
    return q === -1 ? { path: url, queryString: '' } : { path: url.slice(0, q), queryString: url.slice(q + 1) }
  }
}

/** Decode before redacting: a percent-encoded `sk-…` matches no pattern. */
function decodeQuery(qs: string): string {
  try { return decodeURIComponent(qs.replace(/\+/g, ' ')) } catch { return qs }
}

function traceCard(o: {
  node: TraceTreeNode; nodes: TraceTreeNode[]; inner: number; budget: number; now: number
}): Line[] {
  const { node, nodes, inner, now } = o
  const out: Line[] = [titleLine(node.label, theme.accent, inner)]

  const live = node.depth === 0 && node.endedAt == null && !node.incomplete
  const lead: Line = node.status == null
    ? { text: '—', dim: true }
    : { text: String(node.status), color: statusColor(node.status) }
  out.push(...stripLines(
    buildStrip({ lead, durationMs: node.durationMs, startedAt: node.startedAt, inner }), inner))
  if (live) {
    // Facts so far, not a verdict — the strip above already shows the
    // aggregates rolled up over whatever ran before `now`; this line is only
    // the "still going" fact those numbers don't say on their own.
    const elapsed = Math.max(0, Math.round((now - node.startedAt) / 1000))
    out.push(L(clip(`${G.live} LIVE — started ${fmtTime(node.startedAt)}, ${elapsed}s ago`, inner), { color: theme.accent }))
  } else if (node.status == null && !node.incomplete) {
    // The known-unknown story is "not observed" (closed, no status) OR
    // "force-closed by the sweep" (incomplete below) — never both: an
    // incomplete root's status IS explained, just not by this line.
    out.push(...wrapWords('not observed (handler threw, or the connection upgraded)', inner)
      .map((t) => L(t, { dim: true })))
  }
  if (node.incomplete) {
    // Split on the dash first (a visual break when both halves fit their own
    // line), THEN word-wrap each half independently. `wrapOn` alone will not
    // do here: its own line-packer CLIPS a segment longer than `inner`
    // (losing the sentence's whole second half) rather than wrapping it —
    // fine for the short segments `missingPayloadLines` below feeds it, wrong
    // for this one, whose second half routinely exceeds a narrow pane.
    const INCOMPLETE_SENTENCE = 'response never finished — force-closed by the stale sweep '
      + 'after being open ≥10m. Totals are what was observed.'
    const [firstHalf, secondHalf] = INCOMPLETE_SENTENCE.split(' — ')
    out.push(
      ...wrapWords(firstHalf, inner).map((t) => L(t, { color: theme.warn })),
      ...wrapWords(`— ${secondHalf}`, inner).map((t) => L(t, { color: theme.warn })),
    )
    const openFor = node.endedAt != null ? fmtMs(node.endedAt - node.startedAt) : '—'
    out.push(L(clip(`open for ${openFor} (observation, not duration)`, inner), { color: theme.warn }))
  }

  const sub = subtree(nodes, node)
  const reqs = sub.filter((n) => n.type === 'request')
  const tools = sub.filter((n) => n.type === 'tool')
  // Per-node counter, never summed by the query layer — the sweep only ever
  // knows what it took from one trace at a time (spec §4).
  const expired = sub.concat(node).reduce((s, n) => s + n.expiredCalls, 0)

  if (node.calls === 0) {
    out.push(L(expired > 0
      ? clip(`${fmtNum(expired)} call${expired === 1 ? '' : 's'} expired (older than 30d)`, inner)
      : 'waiting for first call…', { dim: true }))
    return out
  }

  if (sub.length > 0) out.push(L(clip(stepsShape(sub), inner)))

  const priced = `${node.pricedCalls > 0 ? fmtUsd(node.costUsd) : '—'} · ${fmtNum(node.pricedCalls)} of ${fmtNum(node.calls)} calls priced`
  out.push(...wrapOn(priced, ' · ', inner).map((t) => L(t)))
  if (expired > 0) {
    // A partial sum without the caveat is a wrong number presented as fact.
    out.push(L(clip(`(excludes ${fmtNum(expired)} expired call${expired === 1 ? '' : 's'})`, inner), { dim: true }))
  }
  if (node.tokenCalls > 0 || node.tokensIn != null) out.push(...tokenBlock(node, inner))

  const composition = compositionLine(reqs, tools)
  if (composition) out.push(...wrapOn(composition, ' · ', inner).map((t) => L(t, { dim: true })))

  const slowest = reqs.filter((n) => n.durationMs != null)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0]
  if (slowest) out.push(L(clip(`${'slowest'.padEnd(10)}${nameOf(slowest)} · ${fmtMs(slowest.durationMs)}`, inner), { dim: true }))
  const costliest = reqs.filter((n) => n.costUsd != null)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0]
  if (costliest) out.push(L(clip(`${'costliest'.padEnd(10)}${nameOf(costliest)} · ${fmtUsd(costliest.costUsd)}`, inner), { dim: true }))

  const issues = issueParts(reqs, tools, node)
  if (issues.length > 0) {
    out.push(...wrapOn(`${'issues'.padEnd(10)}${issues.join(' · ')}`, ' · ', inner)
      .map((t) => L(t, { color: theme.warn })))
  }
  return out
}

/** `◇◇◇◆🔧◇◇◆🔧  +8` — the shape of the trace in one line, in wall order. */
function stepsShape(sub: TraceTreeNode[]): string {
  const glyphs = sub
    .filter((n) => n.type !== 'trace')
    .sort((a, b) => a.startedAt - b.startedAt || a.id - b.id)
    .map((n) => (n.type === 'tool' ? G.tool : n.llm || n.model != null ? G.llm : G.api))
  const shown = glyphs.slice(0, STEPS_CAP).join('')
  const rest = glyphs.length - Math.min(glyphs.length, STEPS_CAP)
  return `steps  ${shown}${rest > 0 ? `  +${rest}` : ''}`
}

function compositionLine(reqs: TraceTreeNode[], tools: TraceTreeNode[]): string {
  const llm = reqs.filter((n) => n.llm || n.model != null)
  const api = reqs.filter((n) => !(n.llm || n.model != null))
  const models = [...new Set(llm.map((n) => n.model).filter(Boolean))] as string[]
  const services = [...new Set(api.map((n) => n.hostname).filter(Boolean))]
  const parts: string[] = []
  if (llm.length > 0) {
    const which = models.length === 1 ? ` (${models[0]})` : models.length > 1 ? ` (${models.length} models)` : ''
    parts.push(`${llm.length} LLM${which}`)
  }
  if (tools.length > 0) parts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}`)
  if (api.length > 0) {
    parts.push(`${api.length} API (${services.length} service${services.length === 1 ? '' : 's'})`)
  }
  return parts.join(' · ')
}

function issueParts(reqs: TraceTreeNode[], tools: TraceTreeNode[], node: TraceTreeNode): string[] {
  const parts: string[] = []
  const bad = reqs.filter((n) => n.status != null && n.status >= 400).length
  const dead = reqs.filter((n) => n.status == null).length
  const errored = tools.filter((n) => n.toolStatus === 'error').length
  const unresolved = tools.filter((n) => n.toolStatus === 'unresolved').length
  if (bad > 0) parts.push(`${bad} call${bad === 1 ? '' : 's'} ≥400`)
  if (dead > 0) parts.push(`${dead} network failure${dead === 1 ? '' : 's'}`)
  if (errored > 0) parts.push(`${errored} tool error${errored === 1 ? '' : 's'}`)
  if (unresolved > 0) parts.push(`${unresolved} unresolved`)
  if (node.incomplete) parts.push('incomplete')
  return parts
}

function nameOf(n: TraceTreeNode): string {
  if (n.model != null) return n.model
  return `${n.method ? `${n.method} ` : ''}${n.hostname ?? n.label}`
}

/** The DFS slice that belongs to `node`: everything after it, up to the first
 *  row back at its own depth. A nested `withTrace` summarises itself, not the
 *  whole trace it happens to sit in. */
function subtree(nodes: TraceTreeNode[], node: TraceTreeNode): TraceTreeNode[] {
  const start = nodes.indexOf(node)
  if (start === -1) return []
  const out: TraceTreeNode[] = []
  for (let i = start + 1; i < nodes.length; i++) {
    if (nodes[i].depth <= node.depth) break
    out.push(nodes[i])
  }
  return out
}

function foldCard(members: TraceTreeNode[], inner: number): Line[] {
  const first = members[0]
  const out: Line[] = [titleLine(
    `${G.foldClosed} ${members.length}×${first.method ? ` ${first.method}` : ''} ${entityOf(first)}`.trim(),
    undefined, inner)]

  const prefix = commonPrefix(members.map(endpointOf))
  if (prefix) out.push(...capLines(wrapOn(`${prefix}*`, '/', inner), ENDPOINT_CAP, { dim: true }))

  const spans = members.map((m) => m.durationMs).filter((d): d is number => d != null).sort((a, b) => a - b)
  const start = Math.min(...members.map((m) => m.startedAt))
  const end = Math.max(...members.map((m) => m.endedAt ?? m.startedAt))
  out.push(L(clip(`span ${fmtMs(end - start)}`, inner)))
  if (spans.length > 0) {
    const mid = spans.length % 2 === 1
      ? spans[(spans.length - 1) / 2]
      : Math.round((spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2)
    out.push(...wrapOn(`min ${fmtMs(spans[0])} · median ${fmtMs(mid)} · max ${fmtMs(spans[spans.length - 1])}`, ' · ', inner)
      .map((t) => L(t, { dim: true })))
  }
  // A fold can only ever contain successes — it breaks on the first failure
  // (spec §2.3) — but the row states the fact rather than leaving it implied.
  const allOk = members.every((m) => m.status != null && m.status < 400)
  out.push(L(allOk ? 'all 2xx/3xx' : 'mixed statuses', { color: allOk ? theme.ok : theme.warn }))
  out.push(L('⏎/l expands', { dim: true }))
  return out
}

/** The same short service name the tree row shows — `sap.com`, not the tenant's
 *  40-character hostname, which is on the host line anyway. */
function entityOf(n: TraceTreeNode): string {
  return n.hostname ? detectEntity(n.hostname).entity : ''
}

function endpointOf(n: TraceTreeNode): string {
  return n.method && n.label.startsWith(`${n.method} `) ? n.label.slice(n.method.length + 1) : n.label
}

function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return ''
  let p = paths[0]
  for (const q of paths) {
    let i = 0
    while (i < p.length && i < q.length && p[i] === q[i]) i++
    p = p.slice(0, i)
  }
  if (paths.some((q) => q !== p)) {
    const cut = p.lastIndexOf('/')
    p = cut >= 0 ? p.slice(0, cut + 1) : p
  }
  return p
}

function infoCard(row: DisplayRow, inner: number): Line[] {
  // The waiting row (live root, zero calls yet) is a DIFFERENT epistemic
  // state from the expired-calls row below — nothing has been lost, nothing
  // has even happened yet — so it needs its own card, not this one's "gone"
  // wording (review round 1, Finding 1: rendering that on a live empty root
  // is exactly the false data-loss claim spec §4 forbids).
  if (row.key === 'info:waiting') {
    return [
      titleLine('waiting for first call…', undefined, inner),
      L(clip('the trace is open; outbound calls will appear here as they complete', inner), { dim: true }),
    ]
  }
  return [
    titleLine('expired calls', theme.warn, inner),
    L(clip(row.step.trim().replace(/^·\s*/, ''), inner), { dim: true }),
    L(clip('metadata for these calls is gone; the rest of the trace is intact', inner), { dim: true }),
  ]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TraceDetail({ row, nodes = [], db, width, height, retention, now }: {
  row: DisplayRow | undefined
  /** The whole `traceTree` node list — the root and fold cards summarise rows
   *  that are already in memory rather than re-querying per poll. */
  nodes?: TraceTreeNode[]
  db: StorageDriver
  width: number
  height: number
  retention?: Retention
  now?: number
}) {
  const inner = Math.max(8, width - 4)
  // Spec §3, end to end: B = max(12, rows − 12); content C = B − 5. `height` is
  // the terminal's row count, so the −12 (the chrome the screen spends on tabs,
  // header, footer and the tree pane's own margins) is subtracted HERE — the
  // one place that knows it is a row count and not a budget.
  const content = Math.max(4, Math.max(12, height - 12) - 5)

  const node = row?.kind === 'node' ? row.node : undefined
  const requestId = node?.type === 'request' ? node.requestId : null
  const detail = useMemo(
    () => (requestId == null ? null : (query.requestDetail(db, requestId) as any)),
    [db, requestId],
  )
  const payloadPresent = detail?.payload != null
  // Memoized by (requestId, payloadPresent) exactly as spec §3 requires: a
  // stored payload never changes after it is written, so re-walking a 48 KB
  // request body on every 1s poll would be pure waste.
  const ex = useMemo(
    () => (detail?.payload != null
      ? extractExchange(detail.payload.reqBody ?? null, detail.payload.resBody ?? null)
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestId, payloadPresent],
  )

  const toolId = node?.type === 'tool' ? node.id : null
  const io = useMemo(
    () => (toolId == null ? null : query.toolIo(db, toolId)),
    // `endedAt`/`toolStatus` move exactly once, when the tool closes and its
    // result lands — which is the one moment this must re-read.
    [db, toolId, node?.endedAt, node?.toolStatus],
  )

  if (!row) return null
  const r = retention ?? readerRetention()
  const clock = now ?? Date.now()

  let lines: Line[] = []
  if (row.kind === 'fold') lines = foldCard(row.members ?? [], inner)
  else if (row.kind === 'info') lines = infoCard(row, inner)
  else if (node?.type === 'trace') lines = traceCard({ node, nodes, inner, budget: content, now: clock })
  else if (node?.type === 'tool') lines = toolCard({ node, io, inner, budget: content, retention: r, now: clock })
  else if (node?.type === 'request' && (node.llm || node.model != null)) {
    lines = llmCard({ node, detail, ex, inner, budget: content, retention: r, now: clock })
  } else if (node?.type === 'request') {
    lines = apiCard({ node, detail, inner, retention: r, now: clock })
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={width}>
      {fitCard(lines, content).map((l, i) => <LineView key={i} line={l} inner={inner} />)}
    </Box>
  )
}

/** The last word on the height budget. The LLM card allocates against `C` line
 *  by line, but the cards that are just as long as their data (a tool's ARGS, a
 *  root's issue list) need a backstop, and Ink does not clip — a card that
 *  overran would paint over the tree pane's own rows.
 *
 *  Elaboration goes first, from the bottom up: losing `written 0` costs a
 *  detail, losing the `issues` line costs the reason the user opened the trace.
 *  Only then does the tail truncate, and what it dropped is stated. */
function fitCard(lines: Line[], budget: number): Line[] {
  if (lines.length <= budget) return lines
  const kept = [...lines]
  for (let i = kept.length - 1; i >= 0 && kept.length > budget; i--) {
    if (kept[i].optional) kept.splice(i, 1)
  }
  if (kept.length <= budget) return kept
  if (budget <= 1) return kept.slice(0, Math.max(0, budget))
  return [
    ...kept.slice(0, budget - 1),
    L(`+${kept.length - (budget - 1)} more lines · ⏎ opens the payload`, { dim: true }),
  ]
}

/** Every line is padded to the full inner width before it is handed to Ink.
 *  Ink pads a box's children only when its own layout pass agrees about the
 *  available width, and this pane sits in a stated-width two-column row — one
 *  disagreement and the card renders with a ragged right edge, which is the
 *  exact wart this task exists to remove. Padding here makes the box
 *  rectangular by construction. */
function LineView({ line, inner }: { line: Line; inner: number }) {
  if (line.segs) {
    const used = line.segs.reduce((n, s) => n + visWidth(s.text ?? ''), 0)
      + Math.max(0, line.segs.length - 1) * 3
    return (
      <Text wrap="truncate">
        {line.segs.map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text dimColor>{' · '}</Text>}
            <Text color={s.color} dimColor={s.dim} bold={s.bold}>{s.text}</Text>
          </React.Fragment>
        ))}
        <Text>{' '.repeat(Math.max(0, inner - used))}</Text>
      </Text>
    )
  }
  return (
    <Text wrap="truncate" color={line.color} dimColor={line.dim} bold={line.bold}>
      {padCell(line.text ?? '', inner)}
    </Text>
  )
}
