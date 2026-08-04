import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme, latencyColor } from '../theme.js'
import { Card, TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtNum, fmtMs } from '../../format.js'

const WINDOWS = [
  { label: 'today', days: 0 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
] as const

const COLS: ColDef[] = [
  { label: 'Entity', grow: true, width: 16 },
  { label: 'Cost', width: 11, align: 'right' },
  { label: 'Calls', width: 9, align: 'right' },
  { label: 'Err %', width: 7, align: 'right' },
  { label: 'Latency', width: 9, align: 'right' },
]

export function OverviewScreen({ db, scope, onSubFocus }: {
  db: StorageDriver; scope?: Scope; onSubFocus?: (focused: boolean) => void
}) {
  const [win, setWin] = useState(2) // default 30d
  const [inSelector, setInSelector] = useState(false)
  const days = WINDOWS[win].days
  const label = WINDOWS[win].label
  const deps = [win, scope?.projectIds?.[0], scope?.services?.[0]]
  const o = usePoll(() => query.overview(db, Date.now(), days, scope), 1000, deps)
  const entities = usePoll(() => query.entityList(db, Date.now(), days, scope), 1000, deps)
  const { columns, rows } = useTermSize()
  const widths = colWidths(columns - 2, COLS)
  const maxRows = Math.max(3, rows - 14)

  const focusSelector = (v: boolean) => {
    setInSelector(v)
    onSubFocus?.(v)
  }

  useInput((_input, key) => {
    if (!inSelector) {
      if (key.downArrow) focusSelector(true)
      return
    }
    if (key.upArrow || key.escape) focusSelector(false)
    if (key.rightArrow) setWin((w) => (w + 1) % WINDOWS.length)
    if (key.leftArrow) setWin((w) => (w + WINDOWS.length - 1) % WINDOWS.length)
  })

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>window: </Text>
        {WINDOWS.map((w, i) => (
          <Text
            key={w.label}
            bold={i === win}
            inverse={inSelector && i === win}
            color={i === win ? theme.accent : undefined}
            dimColor={i !== win}
          >
            {i > 0 ? '  ' : ''}{w.label}
          </Text>
        ))}
        <Text dimColor>{inSelector ? '  ←→ change · ↑ back' : '  (↓ to change)'}</Text>
      </Box>
      <Box gap={1} marginTop={1}>
        <Card
          label={`LLM spend (${label})`}
          value={days === 0 ? fmtUsd(o.llmSpend30d) : `${fmtUsd(o.llmSpend30d)} (today ${fmtUsd(o.llmSpendToday)})`}
          color={theme.cost}
        />
        <Card label="Total calls" value={fmtNum(o.totalCalls)} />
        <Card label="Error rate" value={`${(o.errorRate * 100).toFixed(1)}%`} color={o.errorRate > 0.05 ? theme.err : theme.ok} />
        <Card label="Avg latency" value={fmtMs(o.avgLatencyMs)} color={latencyColor(o.avgLatencyMs)} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <TableHeader cols={COLS} widths={widths} />
        {entities.slice(0, maxRows).map((e: any) => (
          <TableRow
            key={e.entity}
            cols={COLS}
            widths={widths}
            cells={[
              { text: e.entity, color: e.entityClass === 'llm' ? theme.entityLlm : theme.entityGeneral, bold: e.entityClass === 'llm' },
              { text: e.entityClass === 'llm' ? fmtUsd(e.costUsd) : '—', color: theme.cost },
              { text: fmtNum(e.calls) },
              { text: `${(e.errorRate * 100).toFixed(1)}%`, color: e.errorRate > 0 ? theme.err : theme.dim },
              { text: fmtMs(e.avgLatencyMs), color: latencyColor(e.avgLatencyMs) },
            ]}
          />
        ))}
      </Box>
    </Box>
  )
}
