import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver, type TraceRow } from '@burn0/core'
import { useTermSize } from '../hooks.js'
import { theme, statusColor, latencyColor } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtMs, fmtTime, fmtBytes, fmtTokPair } from '../../format.js'

/** One unified chronological stream of every request — the only screen where LLM
 *  and API calls appear interleaved, which is the whole §2.6 thesis. */

export type LogFilter = 'all' | 'llm' | 'api' | 'errors'
const FILTERS: LogFilter[] = ['all', 'llm', 'api', 'errors']

const PAGE = 50
const POLL_MS = 400
/** Start paging older rows this far before the cursor reaches the end. */
const PREFETCH = 5

const COLS: ColDef[] = [
  { label: 'Time', width: 8 },
  { label: 'St', width: 4 },
  { label: 'Method', width: 6 },
  { label: 'Host', width: 15 },
  { label: 'Endpoint', grow: true, width: 22 },
  { label: 'Volume', width: 11, align: 'right' },
  { label: 'Cost', width: 10, align: 'right' },
  { label: 'Took', width: 7, align: 'right' },
]

function toQuery(f: LogFilter): { llm: boolean | null; errorsOnly?: boolean } {
  if (f === 'llm') return { llm: true }
  if (f === 'api') return { llm: false }
  if (f === 'errors') return { llm: null, errorsOnly: true }
  return { llm: null }
}

export function LogsScreen({ db, scope, onOpen }: {
  db: StorageDriver; scope?: Scope; onOpen: (id: number) => void
}) {
  const [filter, setFilter] = useState<LogFilter>('all')
  const [rows, setRows] = useState<TraceRow[]>([])
  const [cursor, setCursor] = useState(0)
  const [follow, setFollow] = useState(true)
  const newestId = useRef(0)
  const exhausted = useRef(false)
  const followRef = useRef(follow)
  followRef.current = follow

  // Scope is an object rebuilt every render, so it cannot be a dependency itself.
  const scopeKey = `${scope?.projectIds?.join(',') ?? '*'}|${scope?.services?.join(',') ?? '*'}`

  const { columns, rows: termRows } = useTermSize()
  const widths = colWidths(columns - 2, COLS)
  const maxRows = Math.max(3, termRows - 9)
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, rows.length - maxRows))

  // Changing the filter restarts the stream: a half-filtered buffer would show
  // rows the current filter excludes.
  useEffect(() => {
    try {
      const first = query.traces(db, { ...toQuery(filter), limit: PAGE, scope })
      setRows(first)
      setCursor(0)
      newestId.current = first.length ? first[0].id : 0
      exhausted.current = first.length < PAGE
    } catch {
      setRows([])
    }
  }, [filter, scopeKey])

  // Live tail. New rows are always ingested — pausing moves the cursor with them
  // rather than dropping them, so nothing is ever hidden.
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const fresh = query.liveTail(db, newestId.current, { ...toQuery(filter), limit: PAGE, scope })
        if (!fresh.length) return
        newestId.current = fresh[fresh.length - 1].id
        const newestFirst = [...fresh].reverse()
        setRows((prev) => [...newestFirst, ...prev])
        setCursor((c) => (followRef.current ? 0 : c + newestFirst.length))
      } catch {}
    }, POLL_MS)
    ;(t as any).unref?.()
    return () => clearInterval(t)
  }, [filter, scopeKey])

  const loadOlder = (current: TraceRow[]) => {
    if (exhausted.current || current.length === 0) return
    try {
      const older = query.traces(db, {
        ...toQuery(filter), beforeId: current[current.length - 1].id, limit: PAGE, scope,
      })
      if (older.length < PAGE) exhausted.current = true
      if (!older.length) return
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id))
        return [...prev, ...older.filter((r) => !seen.has(r.id))]
      })
    } catch {}
  }

  useInput((input, key) => {
    if (key.upArrow) {
      // tail -f semantics: reaching for history is what pauses the follow
      setFollow(false)
      setCursor((c) => Math.max(0, c - 1))
    }
    if (key.downArrow) {
      setFollow(false)
      setCursor((c) => Math.min(rows.length - 1, c + 1))
      if (at >= rows.length - PREFETCH) loadOlder(rows)
    }
    if (input === 'f') {
      setFollow((f) => {
        if (!f) setCursor(0)
        return !f
      })
    }
    if (input === '/') setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length])
    if (key.return && rows[at]) onOpen(rows[at].id)
  })

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{`filter: ${filter}`}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text color={follow ? theme.ok : theme.warn}>{follow ? '▶ following' : '⏸ paused'}</Text>
        </Box>
      </Box>
      <TableHeader cols={COLS} widths={widths} />
      {rows.length === 0
        ? <Text dimColor>No requests match this filter.</Text>
        : rows.slice(start, start + maxRows).map((r, i) => (
          <TableRow
            key={r.id}
            cols={COLS}
            widths={widths}
            selected={start + i === at}
            cells={cells(r)}
          />
        ))}
    </Box>
  )
}

function cells(r: TraceRow) {
  return [
    { text: fmtTime(r.startedAt), dim: true },
    { text: r.status == null ? 'ERR' : String(r.status), color: statusColor(r.status) },
    { text: r.method },
    { text: r.hostname, color: r.provider ? theme.entityLlm : theme.entityGeneral },
    { text: r.normalizedEndpoint },
    { text: volume(r), dim: true },
    // NULL cost is unpriced, not free — §3.6
    { text: fmtUsd(r.costUsd), color: theme.cost },
    { text: fmtMs(r.latencyMs), color: latencyColor(r.latencyMs) },
  ]
}

/** Tokens for an LLM call, response bytes for everything else. Both render a gap
 *  when the provider reported nothing and when the capture path never measured. */
function volume(r: TraceRow): string {
  if (r.tokensIn != null || r.tokensOut != null) {
    return fmtTokPair(r.tokensIn, r.tokensCached, r.tokensOut)
  }
  return r.resBytes == null ? '—' : fmtBytes(r.resBytes)
}
