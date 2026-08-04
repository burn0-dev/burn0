import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme, statusColor, latencyColor } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtMs, fmtAgo, fmtNum } from '../../format.js'

const LLM_COLS: ColDef[] = [
  { label: 'Time', width: 9 },
  { label: 'Model', grow: true, width: 20 },
  { label: 'Tokens', width: 15, align: 'right' },
  { label: 'Cost', width: 11, align: 'right' },
  { label: 'Latency', width: 9, align: 'right' },
  { label: 'Project', width: 14 },
]

const API_COLS: ColDef[] = [
  { label: 'Time', width: 9 },
  { label: 'St', width: 4 },
  { label: 'Method', width: 7 },
  { label: 'Entity', width: 16 },
  { label: 'Endpoint', grow: true, width: 24 },
  { label: 'Latency', width: 9, align: 'right' },
  { label: 'Project', width: 14 },
]

export function TracesScreen({ db, llm, scope, onOpen }: {
  db: StorageDriver; llm: boolean; scope?: Scope; onOpen: (id: number) => void
}) {
  const { columns, rows } = useTermSize()
  const maxRows = Math.max(5, rows - 8)
  const trs = usePoll(
    () => query.traces(db, { llm, limit: 50, scope }), 1000, [scope?.projectIds?.[0], scope?.services?.[0]])
  const visible = trs.slice(0, maxRows)
  const [cursor, setCursor] = useState(0)
  const cols = llm ? LLM_COLS : API_COLS
  const widths = colWidths(columns - 2, cols)

  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow) setCursor((c) => Math.min(visible.length - 1, c + 1))
    if (key.return && visible[cursor]) onOpen(visible[cursor].id)
  })

  if (visible.length === 0) return <Text dimColor>{llm ? 'No LLM calls yet.' : 'No API calls yet.'}</Text>

  return (
    <Box flexDirection="column">
      <TableHeader cols={cols} widths={widths} />
      {visible.map((r, i) => (
        <TableRow
          key={r.id}
          cols={cols}
          widths={widths}
          selected={i === cursor}
          cells={llm ? [
            { text: fmtAgo(r.startedAt), dim: true },
            { text: r.model ?? '?', color: theme.model },
            // a call that reported no usage block renders a gap, not 0→0
            { text: r.tokensIn == null && r.tokensOut == null
              ? '—'
              : `${fmtNum(r.tokensIn ?? 0)}→${fmtNum(r.tokensOut ?? 0)}` },
            { text: fmtUsd(r.costUsd), color: theme.cost },
            { text: fmtMs(r.latencyMs), color: latencyColor(r.latencyMs) },
            { text: r.project, dim: true },
          ] : [
            { text: fmtAgo(r.startedAt), dim: true },
            { text: String(r.status ?? 'ERR'), color: statusColor(r.status) },
            { text: r.method },
            { text: r.entity, bold: true },
            { text: r.normalizedEndpoint },
            { text: fmtMs(r.latencyMs), color: latencyColor(r.latencyMs) },
            { text: r.project, dim: true },
          ]}
        />
      ))}
    </Box>
  )
}
