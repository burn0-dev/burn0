import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, redactQueryString, type StorageDriver } from '@burn0/core'
import { usePoll } from '../hooks.js'
import { theme, statusColor } from '../theme.js'
import { G, padCell, visWidth } from '../glyphs.js'
import { extractTranscript, type TranscriptEntry } from '../llm-io.js'
import { tokenBreakdown } from '../token-block.js'
import { missingPayloadLines, readerRetention } from './TraceDetail.js'
import { useFooter } from '../footer.js'
import { fmtMs, fmtUsd, fmtBytes, fmtTime, fmtNum } from '../../format.js'
import type { Viewport } from '../App.js'

/** Full request detail (spec 2026-08-06): fixed chrome, five information tabs,
 *  one content surface at a time, and a real line viewport. The parsed
 *  conversation and the raw bodies never render together; headers and SSE
 *  frames never sit above the user's actual input.
 *
 *  All heavy work — transcript extraction, JSON pretty-printing, line
 *  wrapping — is memoized on (requestId, payload presence, tab, width).
 *  Payloads are immutable once written, so the 1s poll re-renders the same
 *  built lines; it never re-parses a body. */

const TABS = ['Summary', 'Input', 'Output', 'Metadata', 'Raw'] as const
type DetailTab = (typeof TABS)[number]

const PRETTY_MAX_BYTES = 16 * 1024
/** Hard ceiling on built lines per tab — the amount omitted is always stated. */
const MAX_LINES = 2000
const CHROME_ROWS = 5

interface DLine {
  text: string
  color?: string
  dim?: boolean
  bold?: boolean
}

const D = (text: string, o: Omit<DLine, 'text'> = {}): DLine => ({ text, ...o })

function redactedUrl(url: string): string {
  const q = url.indexOf('?')
  if (q < 0) return url
  return `${url.slice(0, q)}?${redactQueryString(url.slice(q + 1))}`
}

// ---------------------------------------------------------------------------
// Text helpers — display-cell safe.
// ---------------------------------------------------------------------------

function wrapText(s: string, w: number): string[] {
  const out: string[] = []
  for (const para of s.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (words.length === 0) { out.push(''); continue }
    let line = ''
    for (const word of words) {
      if (line === '') line = word
      else if (visWidth(`${line} ${word}`) <= w) line = `${line} ${word}`
      else { out.push(line); line = word }
      while (visWidth(line) > w) { out.push(padCell(line, w).trimEnd()); line = '' }
    }
    if (line !== '') out.push(line)
  }
  return out
}

/** Raw/code content: preserve line structure, hard-chunk overlong lines so no
 *  cell is ever hidden to the right of the viewport. */
function chunkLines(s: string, w: number): string[] {
  const out: string[] = []
  for (const line of s.split('\n')) {
    if (visWidth(line) <= w) { out.push(line); continue }
    let rest = line
    while (visWidth(rest) > w) {
      let cut = ''
      let used = 0
      for (const cp of rest) {
        const cw = visWidth(cp)
        if (used + cw > w) break
        cut += cp
        used += cw
      }
      out.push(cut)
      rest = rest.slice(cut.length)
    }
    if (rest !== '') out.push(rest)
  }
  return out
}

/** URLs wrap at `?`/`&` boundaries so a query parameter is never sheared
 *  mid-token — `model=gpt` on one line and `-4o` on the next names nothing. */
function wrapUrl(s: string, w: number): string[] {
  const tokens = s.split(/(?=[?&])/)
  const out: string[] = []
  let line = ''
  for (const t of tokens) {
    if (line === '') line = t
    else if (visWidth(line + t) <= w) line += t
    else { out.push(line); line = t }
  }
  if (line) out.push(line)
  return out.flatMap((l) => chunkLines(l, w))
}

function pretty(body: string): string {
  if (Buffer.byteLength(body) > PRETTY_MAX_BYTES) return body
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}

function headerLines(jsonStr: string | null | undefined, w: number): DLine[] {
  if (!jsonStr) return [D('(none)', { dim: true })]
  try {
    const entries = Object.entries(JSON.parse(jsonStr))
    if (entries.length === 0) return [D('(none)', { dim: true })]
    const keyW = Math.min(24, Math.max(...entries.map(([k]) => k.length)) + 1)
    return entries.flatMap(([k, v]) =>
      chunkLines(`${k.padEnd(keyW)} ${String(v)}`, w).map((t) => D(t, { dim: true })))
  } catch {
    return chunkLines(jsonStr, w).map((t) => D(t, { dim: true }))
  }
}

function capped(lines: DLine[]): DLine[] {
  if (lines.length <= MAX_LINES) return lines
  return [
    ...lines.slice(0, MAX_LINES),
    D(`… ${fmtNum(lines.length - MAX_LINES)} more lines omitted (${fmtNum(lines.length)} total)`, { dim: true }),
  ]
}

// ---------------------------------------------------------------------------
// Tab content builders — pure, memoized by the component.
// ---------------------------------------------------------------------------

function transcriptLines(entries: TranscriptEntry[], w: number): DLine[] {
  const out: DLine[] = []
  for (const entry of entries) {
    if (entry.role === 'tool') {
      const r = entry.toolResult!
      out.push(D(`TOOL RESULT ${r.isError ? '✗' : '✓'} ${r.name ?? '—'} · ${fmtBytes(r.bytes)}`, { dim: true }))
      continue
    }
    if (out.length > 0) out.push(D(''))
    if (entry.role === 'system') {
      // Collapsed by design: a system prompt is context, not the exchange.
      const chars = entry.text?.length ?? 0
      out.push(D(`SYSTEM · ${fmtNum(chars)} chars`, { dim: true, bold: true }))
      const first = entry.text?.split('\n').find((l) => l.trim())
      if (first) out.push(D(padCell(`  ${first.trim()}`, w), { dim: true }))
      continue
    }
    out.push(D(entry.role.toUpperCase(), { dim: true, bold: true }))
    if (entry.text != null) out.push(...wrapText(entry.text, w).map((t) => D(t)))
    for (const c of entry.toolCalls ?? []) {
      out.push(...chunkLines(`→ ${c.name}(${c.args ?? ''})`, w).map((t) => D(t, { color: theme.model })))
    }
  }
  return out
}

function summaryLines(d: any, w: number, retention: { payloads: number; metadata: number }, now: number): DLine[] {
  const out: DLine[] = []
  const llm = d.model != null
  out.push(...wrapUrl(`${d.method} ${redactedUrl(d.url)}`, w).map((t) => D(t)))
  out.push(D(`entity ${d.entity}${d.provider ? ` · provider ${d.provider}` : ''}${llm ? ` · model ${d.model}` : ''}`))
  out.push(D(`project ${d.project}`, { dim: true }))
  if (d.tags) out.push(...chunkLines(`tags ${d.tags}`, w).map((t) => D(t, { color: theme.warn })))
  out.push(D(''))
  out.push(D(`waterfall  first byte ${fmtMs(d.firstByteMs ?? null)} → complete ${fmtMs(d.latencyMs)}`, { dim: true }))
  out.push(D(`bytes      ${fmtBytes(d.reqBytes)} out / ${fmtBytes(d.resBytes)} in`, { dim: true }))
  if (llm) {
    const tok = tokenBreakdown({
      tokensIn: d.tokensIn ?? null, tokensOut: d.tokensOut ?? null,
      tokensCached: d.tokensCached ?? null, tokensCacheWrite: d.tokensCacheWrite ?? null,
    })
    out.push(D(tok.head))
    if (tok.fresh != null) out.push(D(`  fresh   ${tok.fresh}`, { dim: true }))
    if (tok.cached != null) out.push(D(`  cached  ${tok.cached}`, { dim: true }))
    if (tok.written != null) out.push(D(`  written ${tok.written}`, { dim: true }))
    out.push(D(`cost       ${d.costUsd != null ? fmtUsd(d.costUsd) : '— unpriced'}`, d.costUsd != null ? { color: theme.cost } : { dim: true }))
  }
  out.push(D(''))
  if (d.payload == null) {
    out.push(...missingPayloadLines(
      llm ? 'conversation' : 'request & response', d.startedAt, retention, w, now,
    ).map((l) => D(l.text ?? '', { dim: l.dim, color: l.color })))
    return out
  }
  out.push(D(`payload captured${d.payload.reqTruncated || d.payload.resTruncated ? ' · truncated at 1MB at capture' : ''}`, { dim: true }))
  if (llm) {
    // A short human preview — the full exchange lives in Input/Output.
    const entries = extractTranscript(d.payload.reqBody, d.payload.resBody)
    const user = entries.filter((e) => e.role === 'user').at(-1)
    const assistant = entries.filter((e) => e.role === 'assistant').at(-1)
    if (user?.text) {
      out.push(D(''))
      out.push(D('USER', { dim: true, bold: true }))
      out.push(...wrapText(user.text, w).slice(0, 3).map((t) => D(t)))
    }
    if (assistant && (assistant.text || assistant.toolCalls?.length)) {
      out.push(D(''))
      out.push(D('ASSISTANT', { dim: true, bold: true }))
      if (assistant.text) out.push(...wrapText(assistant.text, w).slice(0, 5).map((t) => D(t)))
      for (const c of (assistant.toolCalls ?? []).slice(0, 3)) {
        out.push(D(padCell(`→ ${c.name}(${c.args ?? ''})`, w), { color: theme.model }))
      }
    }
    out.push(D(''))
    out.push(D('Input/Output tabs hold the full exchange', { dim: true }))
  }
  return out
}

function inputLines(d: any, w: number, retention: { payloads: number; metadata: number }, now: number): DLine[] {
  if (d.payload == null) {
    return missingPayloadLines(d.model != null ? 'conversation' : 'request & response', d.startedAt, retention, w, now)
      .map((l) => D(l.text ?? '', { dim: l.dim, color: l.color }))
  }
  if (d.model != null) {
    const entries = extractTranscript(d.payload.reqBody, null)
    if (entries.length > 0) return transcriptLines(entries, w)
    return [D('no parseable request messages — see Raw', { dim: true })]
  }
  const out: DLine[] = []
  out.push(...wrapUrl(`${d.method} ${redactedUrl(d.url)}`, w).map((t) => D(t, { bold: true })))
  out.push(D(''))
  out.push(D('REQUEST HEADERS', { dim: true, bold: true }))
  out.push(...headerLines(d.payload.reqHeaders, w))
  if (d.payload.reqBody) {
    out.push(D(''))
    out.push(D(`REQUEST BODY${d.payload.reqTruncated ? ' · truncated at 1MB at capture' : ''}`, { dim: true, bold: true }))
    out.push(...chunkLines(pretty(d.payload.reqBody), w).map((t) => D(t)))
  }
  return out
}

function outputLines(d: any, w: number, retention: { payloads: number; metadata: number }, now: number): DLine[] {
  if (d.payload == null) {
    return missingPayloadLines(d.model != null ? 'conversation' : 'request & response', d.startedAt, retention, w, now)
      .map((l) => D(l.text ?? '', { dim: l.dim, color: l.color }))
  }
  if (d.model != null) {
    const entries = extractTranscript(null, d.payload.resBody)
    if (entries.length > 0) return transcriptLines(entries, w)
    return [D('no parseable response — see Raw', { dim: true })]
  }
  const out: DLine[] = []
  out.push(D(`status ${d.status ?? 'ERR'}`, { color: statusColor(d.status), bold: true }))
  out.push(D(''))
  out.push(D('RESPONSE HEADERS', { dim: true, bold: true }))
  out.push(...headerLines(d.payload.resHeaders, w))
  if (d.payload.resBody) {
    out.push(D(''))
    out.push(D(`RESPONSE BODY${d.payload.resTruncated ? ' · truncated at 1MB at capture' : ''}`, { dim: true, bold: true }))
    out.push(...chunkLines(pretty(d.payload.resBody), w).map((t) => D(t)))
  }
  return out
}

function metadataLines(d: any, w: number): DLine[] {
  const out: DLine[] = []
  out.push(D('TIMING', { dim: true, bold: true }))
  out.push(D(`started    ${fmtTime(d.startedAt)}`))
  out.push(D(`first byte ${fmtMs(d.firstByteMs ?? null)}`))
  out.push(D(`complete   ${fmtMs(d.latencyMs)}`))
  out.push(D(''))
  out.push(D('SIZE', { dim: true, bold: true }))
  out.push(D(`request  ${fmtBytes(d.reqBytes)}`))
  out.push(D(`response ${fmtBytes(d.resBytes)}`))
  if (d.model != null) {
    out.push(D(''))
    out.push(D('TOKENS', { dim: true, bold: true }))
    const tok = tokenBreakdown({
      tokensIn: d.tokensIn ?? null, tokensOut: d.tokensOut ?? null,
      tokensCached: d.tokensCached ?? null, tokensCacheWrite: d.tokensCacheWrite ?? null,
    })
    out.push(D(tok.head))
    if (tok.fresh != null) out.push(D(`  fresh   ${tok.fresh}`, { dim: true }))
    if (tok.cached != null) out.push(D(`  cached  ${tok.cached}`, { dim: true }))
    if (tok.written != null) out.push(D(`  written ${tok.written}`, { dim: true }))
  }
  out.push(D(''))
  out.push(D('IDS', { dim: true, bold: true }))
  out.push(D(`request ${d.id} · project ${d.project}`, { dim: true }))
  if (d.tags) out.push(...chunkLines(`tags ${d.tags}`, w).map((t) => D(t, { dim: true })))
  if (d.payload?.stackSnippet) {
    out.push(D(''))
    out.push(D('CALLED FROM', { dim: true, bold: true }))
    out.push(...chunkLines(d.payload.stackSnippet, w).map((t) => D(t, { dim: true })))
  }
  if (d.payload != null) {
    out.push(D(''))
    out.push(D('REQUEST HEADERS', { dim: true, bold: true }))
    out.push(...headerLines(d.payload.reqHeaders, w))
    out.push(D(''))
    out.push(D('RESPONSE HEADERS', { dim: true, bold: true }))
    out.push(...headerLines(d.payload.resHeaders, w))
  }
  return out
}

function rawLines(d: any, w: number, retention: { payloads: number; metadata: number }, now: number): DLine[] {
  if (d.payload == null) {
    return missingPayloadLines(d.model != null ? 'conversation' : 'request & response', d.startedAt, retention, w, now)
      .map((l) => D(l.text ?? '', { dim: l.dim, color: l.color }))
  }
  const out: DLine[] = []
  out.push(D(`RAW REQUEST BODY${d.payload.reqTruncated ? ' · truncated at 1MB at capture' : ''}`, { dim: true, bold: true }))
  out.push(...(d.payload.reqBody
    ? chunkLines(pretty(d.payload.reqBody), w).map((t) => D(t))
    : [D('(empty)', { dim: true })]))
  out.push(D(''))
  out.push(D(`RAW RESPONSE BODY${d.payload.resTruncated ? ' · truncated at 1MB at capture' : ''}`, { dim: true, bold: true }))
  out.push(...(d.payload.resBody
    ? chunkLines(String(d.payload.resBody), w).map((t) => D(t))
    : [D('(empty)', { dim: true })]))
  return out
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DebugScreen({ db, requestId, viewport, retention, now }: {
  db: StorageDriver
  requestId: number | null
  viewport?: Viewport
  /** Test seams; production falls back to the reader's own config + clock. */
  retention?: { payloads: number; metadata: number }
  now?: number
}) {
  const detail = usePoll(() => (requestId == null ? null : query.requestDetail(db, requestId)), 1000, [requestId])
  const [tab, setTab] = useState<DetailTab>('Summary')
  const [scrolls, setScrolls] = useState<Record<string, number>>({})

  const width = viewport?.columns ?? 78
  const rows = viewport?.rows ?? 19
  const bodyRows = Math.max(3, rows - CHROME_ROWS)

  const d: any = detail
  const payloadPresent = d?.payload != null
  const r = retention ?? readerRetention()
  const clock = now ?? Date.now()

  // Memoized on identity, not on the polled object: a stored payload never
  // changes, so tab content is built once per (request, tab, width).
  const lines: DLine[] = useMemo(() => {
    if (d == null) return []
    switch (tab) {
      case 'Input': return capped(inputLines(d, width, r, clock))
      case 'Output': return capped(outputLines(d, width, r, clock))
      case 'Metadata': return capped(metadataLines(d, width))
      case 'Raw': return capped(rawLines(d, width, r, clock))
      default: return capped(summaryLines(d, width, r, clock))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, payloadPresent, tab, width])

  const maxScroll = Math.max(0, lines.length - bodyRows)
  const top = Math.min(scrolls[tab] ?? 0, maxScroll)
  const setTop = (v: number) => setScrolls((s) => ({ ...s, [tab]: Math.max(0, Math.min(maxScroll, v)) }))

  useInput((input, key) => {
    if (key.leftArrow) setTab((t) => TABS[(TABS.indexOf(t) + TABS.length - 1) % TABS.length])
    if (key.rightArrow) setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length])
    if (key.upArrow) setTop(top - 1)
    if (key.downArrow) setTop(top + 1)
    if (key.pageUp) setTop(top - bodyRows)
    if (key.pageDown) setTop(top + bodyRows)
    if (input === 'g') setTop(0)
    if (input === 'G') setTop(maxScroll)
  })

  useFooter(`←→ ${tab.toLowerCase()} tab · ↑↓ scroll · pgup/pgdn page · g/G top/end · esc back`)

  if (requestId == null || !detail) {
    return <Text dimColor>Select a request from LLM, API, or Network (enter) to inspect it.</Text>
  }

  const llm = d.model != null
  const statusWord = d.status == null ? 'no response'
    : d.status >= 400 ? `failed ${d.status}` : 'completed'
  const title = llm ? `${G.llm} ${d.model} · ${d.provider ?? d.entity}` : `${G.api} ${d.entity}`
  const titleBudget = Math.max(1, width - visWidth(statusWord) - 1)

  const strip = [
    fmtMs(d.latencyMs),
    d.firstByteMs != null ? `first byte ${fmtMs(d.firstByteMs)}` : null,
    llm && d.costUsd != null ? fmtUsd(d.costUsd) : null,
    llm && (d.tokensIn != null || d.tokensOut != null)
      ? `tokens ${d.tokensIn != null ? fmtNum(d.tokensIn) : '—'} → ${d.tokensOut != null ? fmtNum(d.tokensOut) : '—'}`
      : null,
  ].filter(Boolean).join(' · ')

  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate">
        <Text bold color={llm ? theme.entityLlm : undefined}>{padCell(title, titleBudget)}</Text>
        <Text> </Text>
        <Text color={statusColor(d.status)}>{statusWord}</Text>
      </Text>
      <Text dimColor wrap="truncate">{`${d.method} ${d.normalizedEndpoint} · ${fmtTime(d.startedAt)}`}</Text>
      <Text dimColor wrap="truncate">{strip}</Text>
      <Text wrap="truncate">
        {TABS.map((t, i) => (
          <React.Fragment key={t}>
            {i > 0 && <Text>{'  '}</Text>}
            <Text
              bold={t === tab}
              color={t === tab ? theme.accentSoft : undefined}
              backgroundColor={t === tab ? theme.winBg : undefined}
              dimColor={t !== tab}
            >{` ${t} `}</Text>
          </React.Fragment>
        ))}
        {maxScroll > 0 && <Text dimColor>{`  ${top + 1}–${Math.min(lines.length, top + bodyRows)}/${lines.length}`}</Text>}
      </Text>
      <Text color={theme.rule}>{'─'.repeat(Math.max(0, width))}</Text>
      {lines.slice(top, top + bodyRows).map((l, i) => (
        <Text key={top + i} wrap="truncate" color={l.color} dimColor={l.dim} bold={l.bold}>
          {l.text === '' ? ' ' : l.text}
        </Text>
      ))}
    </Box>
  )
}
