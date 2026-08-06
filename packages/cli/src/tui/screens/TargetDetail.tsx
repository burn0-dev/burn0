import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme, statusColor, latencyColor } from '../theme.js'
import { Card, TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtNum, fmtMs, fmtTime } from '../../format.js'
import { useFooter } from '../footer.js'
import { targetLabel, type TargetKey } from '../routes.js'

const PAGE = 50
const PREFETCH = 5
const POLL_MS = 1000

const COLS: ColDef[] = [
  { label: 'Time', width: 8 },
  { label: 'Status', width: 6 },
  { label: 'Route', grow: true, width: 20 },
  { label: 'Cost', width: 10, align: 'right' },
  { label: 'Latency', width: 8, align: 'right' },
]

/** The request list for one model/endpoint. The window means ALL matching
 *  requests — the buffer pages 50 at a time on a (started_at, id) keyset
 *  cursor and only the viewport is rendered, so a 40k-request target stays
 *  usable. Mirrors `LogsScreen`'s buffer discipline. */
export function TargetDetailScreen({ db, scope, windowDays, entity, entityClass, target, onOpenRequest }: {
  db: StorageDriver
  scope?: Scope
  windowDays: query.WindowDays
  entity: string
  entityClass: 'llm' | 'general'
  target: TargetKey
  onOpenRequest: (id: number) => void
}) {
  const scopeKey = `${scope?.projectIds?.join(',') ?? '*'}|${scope?.services?.join(',') ?? '*'}`
  const filterKey = `${entity}|${entityClass}|${targetLabel(target)}|${windowDays}|${scopeKey}`
  const filter: query.DetailFilter = { entity, entityClass, ...target, windowDays, scope }

  const summary = usePoll(() => query.detailSummary(db, filter), 1000, [filterKey])

  const [rows, setRows] = useState<query.DetailRequestRow[]>([])
  const [cursor, setCursor] = useState(0)
  const exhausted = useRef(false)

  // First page — restarted whenever the filter/window/scope changes.
  useEffect(() => {
    try {
      const first = query.detailRequestPage(db, { ...filter, limit: PAGE })
      setRows(first)
      setCursor(0)
      exhausted.current = first.length < PAGE
    } catch {
      setRows([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  // Light forward poll: re-query the first page and prepend unseen rows.
  // The full buffer is never rebuilt.
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const first = query.detailRequestPage(db, { ...filter, limit: PAGE })
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id))
          const fresh = first.filter((r) => !seen.has(r.id))
          return fresh.length ? [...fresh, ...prev] : prev
        })
      } catch {}
    }, POLL_MS)
    ;(t as any).unref?.()
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  const loadOlder = (current: query.DetailRequestRow[]) => {
    if (exhausted.current || current.length === 0) return
    const last = current[current.length - 1]
    try {
      const older = query.detailRequestPage(db, {
        ...filter, beforeStartedAt: last.startedAt, beforeId: last.id, limit: PAGE,
      })
      if (older.length < PAGE) exhausted.current = true
      if (!older.length) return
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id))
        return [...prev, ...older.filter((r) => !seen.has(r.id))]
      })
    } catch {}
  }

  const { columns, rows: termRows } = useTermSize()
  const widths = colWidths(columns - 2, COLS)
  const maxRows = Math.max(3, termRows - 14)
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, rows.length - maxRows))

  useFooter('↑↓ select · enter open request · esc back · q quit')

  useInput((_input, key) => {
    if (key.upArrow) setCursor(Math.max(0, at - 1))
    if (key.downArrow) {
      setCursor(Math.min(rows.length - 1, at + 1))
      if (at >= rows.length - PREFETCH) loadOlder(rows)
    }
    if (key.pageUp) setCursor(Math.max(0, at - maxRows))
    if (key.pageDown) {
      setCursor(Math.min(rows.length - 1, at + maxRows))
      if (at + maxRows >= rows.length - PREFETCH) loadOlder(rows)
    }
    if (key.return && rows[at]) onOpenRequest(rows[at].id)
  })

  const llm = entityClass === 'llm'
  const winLabel = windowDays === 0 ? 'today' : `${windowDays}d`
  const failDetail = summary.errorRate != null && summary.errors > 0
    ? `${(summary.errorRate * 100).toFixed(1)}%` : undefined

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>Overview / </Text>
        <Text bold color={llm ? theme.entityLlm : theme.entityGeneral}>{entity}</Text>
        <Text dimColor> / </Text>
        <Text bold color={theme.model}>{targetLabel(target)}</Text>
        <Text dimColor>{`  ·  ${winLabel}`}</Text>
      </Box>
      <Box gap={1} marginTop={1}>
        <Card
          label="Spend"
          value={llm ? fmtUsd(summary.costUsd) : '—'}
          color={theme.cost}
          detail={llm && summary.pricedCalls > 0 && summary.pricedCalls < summary.calls
            ? `priced ${fmtNum(summary.pricedCalls)}/${fmtNum(summary.calls)}`
            : llm && summary.pricedCalls === 0 && summary.calls > 0 ? 'No priced calls' : undefined}
        />
        <Card label="Calls" value={fmtNum(summary.calls)} />
        <Card
          label="Failed"
          value={fmtNum(summary.errors)}
          color={summary.errors > 0 ? theme.err : theme.ok}
          detail={summary.errors === 0 && summary.calls > 0 ? 'No failed requests' : failDetail}
        />
        <Card
          label="P95"
          value={fmtMs(summary.p95LatencyMs)}
          color={latencyColor(summary.p95LatencyMs)}
          detail={summary.p95LatencyMs == null && summary.calls > 0 ? 'No latency reported' : undefined}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.accent}>{`REQUESTS (${fmtNum(summary.calls)})`}</Text>
        <TableHeader cols={COLS} widths={widths} />
        {rows.length === 0
          ? <Text dimColor>{`No requests in ${winLabel}.`}</Text>
          : rows.slice(start, start + maxRows).map((r, i) => (
            <TableRow
              key={r.id}
              cols={COLS}
              widths={widths}
              selected={start + i === at}
              cells={[
                { text: fmtTime(r.startedAt), dim: true },
                { text: r.status == null ? 'ERR' : String(r.status), color: statusColor(r.status) },
                { text: `${r.method} ${r.normalizedEndpoint}` },
                { text: fmtUsd(r.costUsd), color: theme.cost },
                { text: fmtMs(r.latencyMs), color: latencyColor(r.latencyMs) },
              ]}
            />
          ))}
      </Box>
    </Box>
  )
}
