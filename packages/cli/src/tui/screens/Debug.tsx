import React from 'react'
import { Box, Text } from 'ink'
import { query, type StorageDriver } from '@burn0/core'
import { usePoll } from '../hooks.js'
import { theme, statusColor } from '../theme.js'
import { Section } from '../ui.js'
import { extractPrompt, extractAnswer } from '../llm-io.js'
import { fmtMs, fmtUsd, fmtNum } from '../../format.js'

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

function LlmIO({ d }: { d: any }) {
  const prompt = extractPrompt(d.payload.reqBody)
  const answer = extractAnswer(d.payload.resBody)
  if (!prompt && !answer) return null
  const tokens = d.tokensIn != null || d.tokensOut != null
  return (
    <Box flexDirection="column">
      {/* Stacked, not side by side: prompts and completions are prose, and
          splitting the width halves the line length and doubles the wrapping.
          Stacking also lets a long prompt scroll without dragging the response. */}
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold color={theme.accent}>Input{d.tokensIn != null ? `  (${fmtNum(d.tokensIn)} tok${d.payload && detailCached(d)})` : ''}</Text>
          <Text wrap="wrap">{prompt ?? '—'}</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold color={theme.accent}>Output{d.tokensOut != null ? `  (${fmtNum(d.tokensOut)} tok)` : ''}</Text>
          <Text wrap="wrap">{answer ?? '—'}</Text>
        </Box>
      </Box>
      {tokens && (
        <Text dimColor>
          {`  ${d.model} · ${fmtNum(d.tokensIn ?? 0)} in / ${fmtNum(d.tokensOut ?? 0)} out`}
          {d.costUsd != null ? ` · ${fmtUsd(d.costUsd)}` : ''}
        </Text>
      )}
    </Box>
  )
}

function detailCached(d: any): string {
  return d.tokensCached ? `, ${fmtNum(d.tokensCached)} cached` : ''
}

function pretty(jsonStr: string): string {
  try { return Object.entries(JSON.parse(jsonStr)).map(([k, v]) => `  ${k}: ${v}`).join('\n') } catch { return jsonStr }
}

function clip(s: string): string {
  return s.length > BODY_PREVIEW ? s.slice(0, BODY_PREVIEW) + `\n… (${s.length - BODY_PREVIEW} more chars)` : s
}
