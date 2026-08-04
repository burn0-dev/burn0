import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type StorageDriver } from '@burn0/core'
import type { TraceTreeNode } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme, statusColor, latencyColor } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtNum, fmtMs, fmtTime } from '../../format.js'

/** Two-pane trace view: tree on the left, detail following the selection on the
 *  right. Ink has no layout query, so the width branch is manual — below this,
 *  the detail pane squeezes the tree into unreadability and single-pane wins. */
export const TWO_PANE_MIN_COLUMNS = 110

const TREE_COLS: ColDef[] = [
  { label: 'Step', grow: true, width: 26 },
  { label: 'Cost', width: 10, align: 'right' },
  { label: 'Tokens', width: 13, align: 'right' },
  { label: 'Took', width: 8, align: 'right' },
]

export function TraceView({ db, traceId, columns: forced, onBack, onOpenRequest }: {
  db: StorageDriver
  traceId: number
  /** Override for tests and for callers that already measured. */
  columns?: number
  onBack: () => void
  onOpenRequest: (id: number) => void
}) {
  const term = useTermSize()
  const columns = forced ?? term.columns
  const nodes = usePoll(() => query.traceTree(db, traceId), 1000, [traceId])
  const [cursor, setCursor] = useState(0)
  const at = Math.min(cursor, Math.max(0, nodes.length - 1))
  const twoPane = columns >= TWO_PANE_MIN_COLUMNS
  const treeWidth = twoPane ? Math.floor(columns * 0.62) : columns - 2
  const widths = colWidths(treeWidth, TREE_COLS)
  const maxRows = Math.max(3, term.rows - 10)
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, nodes.length - maxRows))

  useInput((_input, key) => {
    if (key.escape) { onBack(); return }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow) setCursor((c) => Math.min(nodes.length - 1, c + 1))
    const here = nodes[at]
    if (key.return && here?.requestId != null) onOpenRequest(here.requestId)
  })

  if (nodes.length === 0) return <Text dimColor>This trace has no calls left — they expired before it did.</Text>

  const tree = (
    <Box flexDirection="column" width={twoPane ? treeWidth : undefined}>
      <TableHeader cols={TREE_COLS} widths={widths} />
      {nodes.slice(start, start + maxRows).map((n, i) => (
        <TableRow
          key={`${n.type}:${n.id}`}
          cols={TREE_COLS}
          widths={widths}
          selected={start + i === at}
          cells={cells(n)}
        />
      ))}
    </Box>
  )

  if (!twoPane) return tree

  return (
    // The width is stated, not inherited: the tree pane is sized from `columns`,
    // so the container must be laid out against the same number or the detail
    // pane silently gets whatever is left of a different width.
    <Box gap={2} width={columns}>
      {tree}
      <Box flexDirection="column" flexGrow={1}>
        <Text dimColor>DETAIL</Text>
        <Detail node={nodes[at]} />
      </Box>
    </Box>
  )
}

function cells(n: TraceTreeNode) {
  // Depth-prefixed first column; the numeric columns stay right-aligned across
  // depths because indentation lives inside the first cell, not before the row.
  const indent = '  '.repeat(n.depth)
  const marker = n.type === 'tool' ? '🔧 '
    : n.type === 'trace' ? (n.depth === 0 ? '' : '└─ ')
      : n.llm ? '◆ ' : '◇ '
  const label = n.type === 'request' && n.model ? `${n.label}  ${n.model}` : n.label
  // A tool whose children were only inferred is marked, so a guess never reads
  // as certainty. 'turn' means several tools ran at once and nothing beneath
  // could be assigned to one of them.
  const suffix = n.type === 'tool'
    ? `${n.toolStatus && n.toolStatus !== 'ok' ? `  ${n.toolStatus}` : ''}${n.attribution === 'turn' ? '  ~turn' : ''}`
    : n.incomplete ? '  (incomplete)' : ''
  return [
    {
      text: `${indent}${marker}${label}${suffix}`,
      color: n.type === 'tool'
        ? (n.toolStatus === 'error' ? theme.err : n.toolStatus === 'unresolved' ? theme.warn : theme.model)
        : n.type === 'trace' ? theme.accent : n.llm ? theme.entityLlm : undefined,
      bold: n.type !== 'request',
    },
    { text: n.pricedCalls > 0 ? fmtUsd(n.costUsd) : '—', color: theme.cost },
    { text: tokens(n), dim: true },
    { text: fmtMs(n.durationMs), color: latencyColor(n.durationMs) },
  ]
}

function tokens(n: TraceTreeNode): string {
  if (!n.tokensIn && !n.tokensOut) return '—'
  return `${fmtNum(n.tokensIn ?? 0)}→${fmtNum(n.tokensOut ?? 0)}`
}

function Detail({ node }: { node: TraceTreeNode | undefined }) {
  if (!node) return null
  const line = (label: string, value: string) => (
    <Box>
      <Text dimColor>{label.padEnd(10)}</Text>
      <Text>{value}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color={theme.accent} wrap="truncate">{node.label}</Text>
      {node.hostname && line('host', node.hostname)}
      {node.model && line('model', node.model)}
      {line('started', fmtTime(node.startedAt))}
      {line('took', fmtMs(node.durationMs))}
      {node.status != null && (
        <Box>
          <Text dimColor>{'status'.padEnd(10)}</Text>
          <Text color={statusColor(node.status)}>{String(node.status)}</Text>
        </Box>
      )}
      {node.type === 'tool' && line('tool', node.toolStatus ?? 'running')}
      {node.type === 'tool' && node.attribution === 'turn' && (
        <Text color={theme.warn}>calls not attributable — several tools ran at once</Text>
      )}
      {line('calls', fmtNum(node.calls))}
      {line('cost', node.pricedCalls > 0 ? fmtUsd(node.costUsd) : '— unpriced')}
      {line('tokens', tokens(node))}
      {node.incomplete && <Text color={theme.warn}>response never finished</Text>}
      {node.requestId != null && <Text dimColor>enter opens the payload</Text>}
    </Box>
  )
}
