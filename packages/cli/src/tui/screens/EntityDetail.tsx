import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme, latencyColor } from '../theme.js'
import { Card, TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtNum, fmtMs } from '../../format.js'
import { useFooter } from '../footer.js'
import type { EntityReturnState, TargetKey } from '../routes.js'

const LLM_COLS: ColDef[] = [
  { label: 'Model', grow: true, width: 16 },
  { label: 'Cost', width: 11, align: 'right' },
  { label: 'Calls', width: 9, align: 'right' },
  { label: 'Err', width: 7, align: 'right' },
  { label: 'P95', width: 9, align: 'right' },
]

const API_COLS: ColDef[] = [
  { label: 'Endpoint', grow: true, width: 22 },
  { label: 'Calls', width: 9, align: 'right' },
  { label: 'Err', width: 7, align: 'right' },
  { label: 'P95', width: 9, align: 'right' },
]

function targetKey(llm: boolean, t: query.EntityTargetRow): TargetKey {
  return llm ? { model: t.model } : { method: t.method!, endpoint: t.endpoint! }
}

function sameTarget(a: TargetKey, llm: boolean, t: query.EntityTargetRow): boolean {
  return llm ? a.model === t.model : a.method === t.method && a.endpoint === t.endpoint
}

export function EntityDetailScreen({ db, scope, windowDays, entity, entityClass, restore, onOpenTarget }: {
  db: StorageDriver
  scope?: Scope
  windowDays: query.WindowDays
  entity: string
  entityClass: 'llm' | 'general'
  restore?: EntityReturnState
  onOpenTarget: (target: TargetKey, state: EntityReturnState) => void
}) {
  const llm = entityClass === 'llm'
  const scopeKey = `${scope?.projectIds?.join(',') ?? '*'}|${scope?.services?.join(',') ?? '*'}`
  const deps = [entity, entityClass, windowDays, scopeKey]
  const filter: query.DetailFilter = { entity, entityClass, windowDays, scope }

  const summary = usePoll(() => query.detailSummary(db, filter), 1000, deps)
  const targets = usePoll(() => query.entityTargets(db, filter), 1000, deps)

  const [cursor, setCursor] = useState(() => {
    if (!restore) return 0
    const i = restore.selectedTarget
      ? targets.findIndex((t) => sameTarget(restore.selectedTarget!, llm, t))
      : -1
    return i >= 0 ? i : Math.max(0, Math.min(restore.fallbackCursor, targets.length - 1))
  })

  const { columns, rows: termRows } = useTermSize()
  const cols = llm ? LLM_COLS : API_COLS
  const widths = colWidths(columns - 2, cols)
  const maxRows = Math.max(3, termRows - 14)

  const at = Math.min(cursor, Math.max(0, targets.length - 1))
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, targets.length - maxRows))

  useFooter('↑↓ select · enter open · esc back · q quit')

  useInput((_input, key) => {
    if (key.upArrow) setCursor(Math.max(0, at - 1))
    if (key.downArrow) setCursor(Math.min(targets.length - 1, at + 1))
    if (key.pageUp) setCursor(Math.max(0, at - maxRows))
    if (key.pageDown) setCursor(Math.min(targets.length - 1, at + maxRows))
    if (key.return && targets[at]) {
      onOpenTarget(targetKey(llm, targets[at]), {
        selectedTarget: targetKey(llm, targets[at]),
        fallbackCursor: at,
        scroll: start,
      })
    }
  })

  const winLabel = windowDays === 0 ? 'today' : `${windowDays}d`
  const failDetail = summary.errorRate != null && summary.errors > 0
    ? `${(summary.errorRate * 100).toFixed(1)}%` : undefined

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>Overview / </Text>
        <Text bold color={llm ? theme.entityLlm : theme.entityGeneral}>{entity}</Text>
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
        <Text bold color={theme.accent}>{llm ? 'MODELS' : 'ENDPOINTS'}</Text>
        <TableHeader cols={cols} widths={widths} />
        {targets.length === 0
          ? <Text dimColor>{`No requests in ${winLabel}.`}</Text>
          : targets.slice(start, start + maxRows).map((t, i) => (
            <TableRow
              key={llm ? `m:${t.model}` : `e:${t.method} ${t.endpoint}`}
              cols={cols}
              widths={widths}
              selected={start + i === at}
              cells={llm
                ? [
                    { text: t.model ?? '(no model)', color: theme.model, bold: true },
                    { text: fmtUsd(t.costUsd), color: theme.cost },
                    { text: fmtNum(t.calls) },
                    { text: `${(t.errorRate * 100).toFixed(1)}%`, color: t.errorRate > 0 ? theme.err : theme.dim },
                    { text: fmtMs(t.p95LatencyMs), color: latencyColor(t.p95LatencyMs) },
                  ]
                : [
                    { text: `${t.method} ${t.endpoint}` },
                    { text: fmtNum(t.calls) },
                    { text: `${(t.errorRate * 100).toFixed(1)}%`, color: t.errorRate > 0 ? theme.err : theme.dim },
                    { text: fmtMs(t.p95LatencyMs), color: latencyColor(t.p95LatencyMs) },
                  ]}
            />
          ))}
      </Box>
    </Box>
  )
}
