import React from 'react'
import { Box, Text } from 'ink'
import { query, type StorageDriver } from '@burn0/core'
import { usePoll } from '../hooks.js'
import { theme, statusColor } from '../theme.js'
import { Section } from '../ui.js'
import { extractTranscript, type TranscriptEntry } from '../llm-io.js'
import { tokenBreakdown } from '../token-block.js'
import { fmtMs, fmtUsd, fmtBytes } from '../../format.js'

const BODY_PREVIEW = 2000

export function DebugScreen({ db, requestId }: { db: StorageDriver; requestId: number | null }) {
  const detail = usePoll(() => (requestId == null ? null : query.requestDetail(db, requestId)))
  if (requestId == null || !detail) return <Text dimColor>Select a request from LLM, API, or Network (enter) to inspect it.</Text>

  const d: any = detail
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent} wrap="truncate">{`${d.method} ${d.url}`}</Text>
      <Text wrap="truncate">
        <Text>status </Text>
        <Text color={statusColor(d.status)}>{String(d.status ?? 'ERR')}</Text>
        <Text>{` · ${d.entity}`}</Text>
        {d.model && (<><Text color={theme.model}>{` · ${d.model}`}</Text><Text color={theme.cost}>{` · ${fmtUsd(d.costUsd)}`}</Text></>)}
        <Text dimColor>{` · project ${d.project}`}</Text>
      </Text>
      <Text dimColor>{`waterfall: first byte ${fmtMs(d.firstByteMs ?? null)} → complete ${fmtMs(d.latencyMs)}`}</Text>
      {d.tags && <Text wrap="truncate"><Text color={theme.warn}>tags:</Text>{` ${d.tags}`}</Text>}
      {d.payload && d.model && <LlmIO d={d} />}
      {d.payload ? (
        <Box flexDirection="column">
          <Section title={`Request headers`}>
            <Text dimColor wrap="truncate-end">{pretty(d.payload.reqHeaders)}</Text>
          </Section>
          {d.payload.reqBody && (
            <Section title={`Request body${d.payload.reqTruncated ? ' [truncated at 1MB]' : ''}`}>
              <Text wrap="wrap">{clip(d.payload.reqBody)}</Text>
            </Section>
          )}
          <Section title={`Response headers`}>
            <Text dimColor wrap="truncate-end">{pretty(d.payload.resHeaders)}</Text>
          </Section>
          {d.payload.resBody && (
            <Section title={`Response body${d.payload.resTruncated ? ' [truncated at 1MB]' : ''}`}>
              <Text wrap="wrap">{clip(d.payload.resBody)}</Text>
            </Section>
          )}
          {d.payload.stackSnippet && (
            <Section title="Called from">
              <Text dimColor>{d.payload.stackSnippet}</Text>
            </Section>
          )}
        </Box>
      ) : (
        <Text dimColor>Payload expired (7-day retention) — metadata only.</Text>
      )}
    </Box>
  )
}

/** The full conversation the payload carries, chat-style — single-pane users'
 *  only chat surface, so unlike TraceDetail's capped card this renders EVERY
 *  message in order and never clips an argument string; the screen already
 *  scrolls. Visual language matches TraceDetail: dim uppercase role labels,
 *  `→ tool(args…)` lines in the model color, and the shared fresh/cached/
 *  written token block (spec §1.3) in place of the old ", N cached" phrasing. */
function LlmIO({ d }: { d: any }) {
  const transcript = extractTranscript(d.payload.reqBody, d.payload.resBody)
  if (transcript.length === 0) return null
  const tok = tokenBreakdown({
    tokensIn: d.tokensIn ?? null, tokensOut: d.tokensOut ?? null,
    tokensCached: d.tokensCached ?? null, tokensCacheWrite: d.tokensCacheWrite ?? null,
  })
  const showTokens = d.tokensIn != null || d.tokensOut != null
  return (
    <Section title="LLM conversation">
      <Box flexDirection="column">
        {transcript.map((entry, i) => <TranscriptEntryView key={i} entry={entry} />)}
      </Box>
      {showTokens && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{tok.head}</Text>
          {tok.fresh != null && <Text dimColor>{`  fresh   ${tok.fresh}`}</Text>}
          {tok.cached != null && <Text dimColor>{`  cached  ${tok.cached}`}</Text>}
          {tok.written != null && <Text dimColor>{`  written ${tok.written}`}</Text>}
          <Text dimColor>{`  ${d.model}${d.costUsd != null ? ` · ${fmtUsd(d.costUsd)}` : ''}`}</Text>
        </Box>
      )}
    </Section>
  )
}

function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === 'tool') {
    const r = entry.toolResult!
    return (
      <Text dimColor wrap="wrap">
        {`TOOL RESULT ${r.isError ? '✗' : '✓'} ${r.name ?? '—'} · ${fmtBytes(r.bytes)}`}
      </Text>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>{entry.role.toUpperCase()}</Text>
      {entry.text != null && <Text wrap="wrap">{entry.text}</Text>}
      {entry.toolCalls?.map((c, i) => (
        <Text key={i} color={theme.model} wrap="wrap">{`→ ${c.name}(${c.args ?? ''})`}</Text>
      ))}
    </Box>
  )
}

function pretty(jsonStr: string): string {
  try { return Object.entries(JSON.parse(jsonStr)).map(([k, v]) => `  ${k}: ${v}`).join('\n') } catch { return jsonStr }
}

function clip(s: string): string {
  return s.length > BODY_PREVIEW ? s.slice(0, BODY_PREVIEW) + `\n… (${s.length - BODY_PREVIEW} more chars)` : s
}
