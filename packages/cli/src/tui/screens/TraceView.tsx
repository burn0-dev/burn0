import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type StorageDriver } from '@burn0/core'
import type { TraceTreeNode } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme, statusColor } from '../theme.js'
import { buildRows, rowKey, type DisplayRow } from '../tree-model.js'
import { fmtUsd, fmtNum, fmtMs, fmtTime } from '../../format.js'

/** Two-pane trace view: tree on the left, detail following the selection on the
 *  right. Ink has no layout query, so the width branch is manual — below this,
 *  the detail pane squeezes the tree into unreadability and single-pane wins. */
export const TWO_PANE_MIN_COLUMNS = 110

// STEP takes what is left after the three numeric columns and their gaps —
// verified against the spec's own numbers: 140 cols → pane 86 → STEP 53.
const COST_W = 8
const TOKENS_W = 12
const TOOK_W = 7
const GAP = '  '

const FOOTER_TREE = 'q quit · tab/←→ screens · ↑↓ move · h/l fold · ⏎ open · f flat · esc back'
const FOOTER_FLAT = 'q quit · tab/←→ screens · ↑↓ move · h/l fold · ⏎ open · f tree · esc back'
const FOOTER_PRUNED = 'q quit · esc back'

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
  const tree = usePoll(() => query.traceTree(db, traceId), 1000, [traceId])
  const nodes = tree?.nodes ?? []

  const [expanded, setExpanded] = useState(() => new Set<string>())
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const [flat, setFlat] = useState(false)
  const [cursorKey, setCursorKey] = useState<string | null>(null)

  const twoPane = columns >= TWO_PANE_MIN_COLUMNS
  const paneWidth = twoPane ? Math.min(Math.floor(columns * 0.62), 98) : columns - 2
  const detailWidth = columns - paneWidth - 2
  const stepWidth = Math.max(1, paneWidth - (COST_W + TOKENS_W + TOOK_W + 6))

  const rows = useMemo(
    () => (tree ? buildRows({ tree, expanded, collapsed, stepWidth, flat }) : []),
    [tree, expanded, collapsed, stepWidth, flat],
  )

  // Cursor resolution: identity first. A row that disappeared (a fold closed
  // over it, the poll's window rebuilt the tree) falls back to its previous
  // position — and if that position was the last row, follows the new last
  // row, so watching a live trace behaves like `tail -f` rather than freezing
  // on whatever used to be there.
  const prevRef = useRef<{ rows: DisplayRow[]; index: number }>({ rows: [], index: -1 })
  useEffect(() => {
    const { rows: prevRows, index: prevIndex } = prevRef.current
    let idx = cursorKey == null ? -1 : rows.findIndex((r) => r.key === cursorKey)
    if (idx === -1) {
      if (rows.length === 0) idx = -1
      else if (prevRows.length === 0) idx = 0
      else if (prevIndex === prevRows.length - 1) idx = rows.length - 1
      else idx = Math.min(Math.max(prevIndex, 0), rows.length - 1)
    }
    const newKey = idx >= 0 ? rows[idx].key : null
    if (newKey !== cursorKey) setCursorKey(newKey)
    prevRef.current = { rows, index: idx }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const at = Math.max(0, rows.findIndex((r) => r.key === cursorKey))
  const maxRows = Math.max(3, term.rows - 10)
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, rows.length - maxRows))

  const openRow = (key: string) => {
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }
  const closeRow = (key: string) => {
    setCollapsed((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }

  useInput((input, key) => {
    if (key.escape) { onBack(); return }
    if (rows.length === 0) return

    if (key.upArrow) {
      const idx = Math.max(0, at - 1)
      setCursorKey(rows[idx]?.key ?? null)
      return
    }
    if (key.downArrow) {
      const idx = Math.min(rows.length - 1, at + 1)
      setCursorKey(rows[idx]?.key ?? null)
      return
    }
    if (input === 'f') { setFlat((v) => !v); return }

    const row = rows[at]
    if (!row) return

    if (key.return) {
      if (row.requestId != null) { onOpenRequest(row.requestId); return }
      if (row.isBranch) {
        if (isRowExpanded(rows, at, nodes)) closeRow(row.key)
        else openRow(row.key)
      }
      return
    }
    if (input === 'h') {
      if (row.isBranch && isRowExpanded(rows, at, nodes)) {
        closeRow(row.key)
      } else {
        const pk = parentKeyOf(row, nodes)
        if (pk != null) setCursorKey(pk)
      }
      return
    }
    if (input === 'l') {
      if (row.isBranch) openRow(row.key)
      return
    }
  })

  if (tree === null) {
    return (
      <Box flexDirection="column">
        <Text color={theme.warn}>
          Trace no longer in the database — pruned by retention while you were viewing it.
        </Text>
        <Text dimColor>esc returns to the list.</Text>
        <Box marginTop={1}>
          <Text dimColor>{FOOTER_PRUNED}</Text>
        </Box>
      </Box>
    )
  }

  const selected = rows[at]
  const footerText = flat ? FOOTER_FLAT : FOOTER_TREE

  const treePane = (
    <Box flexDirection="column" width={twoPane ? paneWidth : undefined}>
      <TreeHeader stepWidth={stepWidth} />
      {rows.slice(start, start + maxRows).map((r) => (
        <TreeRow key={r.key} row={r} selected={r.key === cursorKey} />
      ))}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {twoPane ? (
        // The width is stated, not inherited: the tree pane is sized from
        // `columns`, so the container must be laid out against the same
        // number or the detail pane silently gets whatever is left of a
        // different width.
        <Box gap={2} width={columns}>
          {treePane}
          <Box flexDirection="column" width={detailWidth}>
            <Text dimColor>DETAIL</Text>
            <Detail node={selected?.node} />
          </Box>
        </Box>
      ) : treePane}
      <Box marginTop={1}>
        <Text dimColor>{footerText}</Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Row rendering — DisplayRow.step arrives PRE-COMPOSED to exactly `stepWidth`
// display cells (surrogate-pair safe). Re-running it through ui.tsx's `fit()`
// would right-truncate it a second time and could shear the 🔧 glyph, so
// these rows are rendered directly instead of through TableRow.
// ---------------------------------------------------------------------------

function TreeHeader({ stepWidth }: { stepWidth: number }) {
  return (
    <Text dimColor wrap="truncate">
      {'STEP'.padEnd(stepWidth)}{GAP}{'COST'.padStart(COST_W)}{GAP}{'TOKENS'.padStart(TOKENS_W)}{GAP}{'TOOK'.padStart(TOOK_W)}
    </Text>
  )
}

function TreeRow({ row, selected }: { row: DisplayRow; selected: boolean }) {
  return (
    <Text inverse={selected} wrap="truncate">
      <Text color={row.stepColor} bold={row.stepBold} dimColor={row.stepDim}>{row.step}</Text>
      <Text>{GAP}</Text>
      <Text color={theme.cost}>{row.cost.padStart(COST_W)}</Text>
      <Text>{GAP}</Text>
      <Text dimColor>{row.tokens.padStart(TOKENS_W)}</Text>
      <Text>{GAP}</Text>
      <Text
        dimColor={row.tookEmphasis === 'dim'}
        color={row.tookEmphasis === 'warn' ? theme.warn : undefined}
      >
        {row.took.padStart(TOOK_W)}
      </Text>
    </Text>
  )
}

// ---------------------------------------------------------------------------
// Navigation helpers — derived from the rendered `rows` array and the raw
// `nodes`, never from tree-model internals (`isOpen`/`isFoldOpen` are not
// exported, and do not need to be: whether a branch is showing its children
// is fully observable from what actually rendered).
// ---------------------------------------------------------------------------

/** The structural nesting depth of a row — the same scale as `node.depth`,
 *  whether the row is a plain node, a fold (its members' depth), or an info
 *  row (one past its owning node's depth, since it renders as that node's
 *  first child). */
function structuralDepth(row: DisplayRow, nodes: TraceTreeNode[]): number {
  if (row.kind === 'node') return row.node!.depth
  if (row.kind === 'fold') return row.members![0].depth
  const id = Number(row.key.slice('info:expired:'.length))
  const owner = nodes.find((n) => n.type !== 'request' && n.id === id)
  return (owner?.depth ?? 0) + 1
}

/** A branch (node or fold) is currently open iff the very next row is one of
 *  its children — depth exactly one past its own. */
function isRowExpanded(rows: DisplayRow[], idx: number, nodes: TraceTreeNode[]): boolean {
  const next = rows[idx + 1]
  if (!next) return false
  return structuralDepth(next, nodes) === structuralDepth(rows[idx], nodes) + 1
}

/** The row key of the structural parent of `row`, or null at the root.
 *  Requests are always leaves in this schema, so a folded leaf's parent is
 *  never itself inside another fold — the scan is safe over the raw DFS
 *  order without re-deriving tree-model's internal parent index. */
function parentKeyOf(row: DisplayRow, nodes: TraceTreeNode[]): string | null {
  if (row.kind === 'info') {
    const id = Number(row.key.slice('info:expired:'.length))
    const owner = nodes.find((n) => n.type !== 'request' && n.id === id)
    return owner ? rowKey(owner) : null
  }
  const node = row.kind === 'fold' ? row.members![0] : row.node!
  if (node.depth === 0) return null
  const idx = nodes.indexOf(node)
  for (let i = idx - 1; i >= 0; i--) {
    if (nodes[i].depth === node.depth - 1) return rowKey(nodes[i])
    if (nodes[i].depth < node.depth - 1) break
  }
  return null
}

// ---------------------------------------------------------------------------
// Detail pane — unchanged this round (Task 13 replaces it with fold/info
// aware content); still keyed off the raw node, so fold and info rows show
// nothing rather than stale data from whatever node preceded them.
// ---------------------------------------------------------------------------

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
