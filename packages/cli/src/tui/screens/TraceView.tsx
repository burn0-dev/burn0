import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type StorageDriver } from '@burn0/core'
import type { TraceTreeNode } from '@burn0/core'
import { usePoll } from '../hooks.js'
import { theme } from '../theme.js'
import { buildRows, rowKey, type DisplayRow } from '../tree-model.js'
import {
  treeColumns, COST_W, TOKENS_W, TOOK_W, type TreeColumns,
} from '../workspace-layout.js'
import { TraceDetail } from './TraceDetail.js'

/** The execution tree plus (when given an inspector width) the selected-node
 *  inspector — the middle and right panes of the LLM workspace. The parent
 *  (`TraceList`) owns pane FOCUS and total geometry; this component owns tree
 *  UI state, keyed per trace via the `cache` ref so switching traces in wide
 *  mode (or opening a request detail) never loses folds or the cursor. */

// Kept as a named export: the old two-pane branch point, still pinned by tests
// and now defined in terms of the shared workspace layout.
export const TWO_PANE_MIN_COLUMNS = 110

const GAP = '  '

export interface TreeUiState {
  expanded: Set<string>
  collapsed: Set<string>
  flat: boolean
  cursorKey: string | null
}

export function TraceView({
  db, traceId, width, height, treeWidth, inspectorWidth, focus, now: forcedNow, cache, onOpenRequest, onFold,
}: {
  db: StorageDriver
  traceId: number
  /** Total cells this component owns (tree + divider + inspector). */
  width: number
  /** Content rows available for tree rows (below the pane/table headers). */
  height: number
  treeWidth: number
  /** null = single-pane (narrow): no inspector, no divider. */
  inspectorWidth: number | null
  /** Which pane the parent routed the keyboard to. 'none' = keys elsewhere. */
  focus: 'tree' | 'inspector' | 'none'
  now?: number
  cache?: React.MutableRefObject<Map<number, TreeUiState>>
  onOpenRequest: (id: number) => void
  /** Reports flat-mode so the parent's footer can describe `f` accurately. */
  onFold?: (flat: boolean) => void
}) {
  const tree = usePoll(() => query.traceTree(db, traceId), 1000, [traceId])
  const nodes = tree?.nodes ?? []

  const cached = cache?.current.get(traceId)
  const [expanded, setExpanded] = useState(() => cached?.expanded ?? new Set<string>())
  const [collapsed, setCollapsed] = useState(() => cached?.collapsed ?? new Set<string>())
  const [flat, setFlat] = useState(cached?.flat ?? false)
  const [cursorKey, setCursorKey] = useState<string | null>(cached?.cursorKey ?? null)

  // Write-through cache: whatever this trace's UI state is now is what a
  // remount (trace switch, request detail round-trip) starts from.
  useEffect(() => {
    cache?.current.set(traceId, { expanded, collapsed, flat, cursorKey })
  }, [traceId, expanded, collapsed, flat, cursorKey, cache])
  useEffect(() => { onFold?.(flat) }, [flat, onFold])

  const cols: TreeColumns = treeColumns(treeWidth)

  const rows = useMemo(
    () => (tree ? buildRows({ tree, expanded, collapsed, stepWidth: cols.stepWidth, flat, now: forcedNow ?? Date.now() }) : []),
    [tree, expanded, collapsed, cols.stepWidth, flat, forcedNow],
  )

  // Cursor resolution across `rows` changes — precedence: (1) was on the last
  // row → follow to the new last row; (2) same key still exists → keep it;
  // (3) clamp to the nearest valid index. A fresh mount restores the cached
  // key when it still exists rather than snapping to the root.
  const prevRowsRef = useRef<DisplayRow[]>([])
  const prevIndexRef = useRef<number>(-1)
  useEffect(() => {
    const prevRows = prevRowsRef.current
    const prevIndex = prevIndexRef.current
    let idx: number
    if (rows.length === 0) {
      idx = -1
    } else if (prevRows.length === 0) {
      const found = cursorKey == null ? -1 : rows.findIndex((r) => r.key === cursorKey)
      idx = found !== -1 ? found : 0
    } else if (prevIndex === prevRows.length - 1) {
      idx = rows.length - 1                                     // was last -> follow
    } else {
      const found = cursorKey == null ? -1 : rows.findIndex((r) => r.key === cursorKey)
      idx = found !== -1 ? found : Math.min(Math.max(prevIndex, 0), rows.length - 1)
    }
    const newKey = idx >= 0 ? rows[idx].key : null
    if (newKey !== cursorKey) setCursorKey(newKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  // Fresh snapshot of the cursor position after EVERY render, so the effect
  // above always resolves against where the cursor actually was.
  useEffect(() => {
    prevRowsRef.current = rows
    prevIndexRef.current = rows.length > 0 ? rows.findIndex((r) => r.key === cursorKey) : -1
  })

  const at = Math.max(0, rows.findIndex((r) => r.key === cursorKey))
  const maxRows = Math.max(3, height)
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
    if (focus !== 'tree') return           // parent routed the keys elsewhere
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
    if (key.pageUp) { setCursorKey(rows[Math.max(0, at - maxRows)]?.key ?? null); return }
    if (key.pageDown) { setCursorKey(rows[Math.min(rows.length - 1, at + maxRows)]?.key ?? null); return }
    if (input === 'f') { setFlat((v) => !v); return }

    const row = rows[at]
    if (!row) return

    if (key.return) {
      if (row.requestId != null) { onOpenRequest(row.requestId); return }
      if (row.isBranch) {
        if (isBranchOpen(row, rows, at, nodes, expanded, collapsed)) closeRow(row.key)
        else openRow(row.key)
      }
      return
    }
    if (input === 'h') {
      if (row.isBranch && isBranchOpen(row, rows, at, nodes, expanded, collapsed)) {
        closeRow(row.key)
      } else {
        const pk = parentKeyOf(row, nodes)
        if (pk != null && rows.some((r) => r.key === pk)) setCursorKey(pk)
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
      <Box flexDirection="column" width={width}>
        <Text color={theme.warn} wrap="truncate">
          Trace no longer in the database — pruned by retention while you were viewing it.
        </Text>
        <Text dimColor>esc returns to the list.</Text>
      </Box>
    )
  }

  const selected = rows[at]

  const treePane = (
    <Box flexDirection="column" width={treeWidth}>
      <TreeHeader cols={cols} focused={focus === 'tree'} />
      {rows.slice(start, start + maxRows).map((r) => (
        <TreeRow key={r.key} row={r} cols={cols} selected={r.key === cursorKey} focused={focus === 'tree'} />
      ))}
    </Box>
  )

  if (inspectorWidth == null) return <Box width={width}>{treePane}</Box>

  return (
    <Box width={width}>
      {treePane}
      <PaneDivider rows={height + 1} />
      <TraceDetail
        row={selected} nodes={nodes} db={db}
        width={inspectorWidth} height={height}
        focused={focus === 'inspector'}
        now={forcedNow}
        onOpenRequest={onOpenRequest}
      />
    </Box>
  )
}

/** One dim 1-cell vertical rule spanning the pane height (headers included). */
export function PaneDivider({ rows }: { rows: number }) {
  return (
    <Box flexDirection="column" width={1}>
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <Text key={i} color={theme.rule}>│</Text>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Row rendering — DisplayRow.step arrives PRE-COMPOSED to exactly `stepWidth`
// display cells (surrogate-pair safe); numeric cells are ASCII and pad with
// String.padStart safely. Optional columns render whole or not at all — the
// header and the values make the same visibility decision (`TreeColumns`).
// ---------------------------------------------------------------------------

function TreeHeader({ cols, focused }: { cols: TreeColumns; focused: boolean }) {
  return (
    <Text wrap="truncate">
      <Text bold color={focused ? theme.accentSoft : undefined} dimColor={!focused}>
        {'EXECUTION'.padEnd(cols.stepWidth)}
      </Text>
      <Text dimColor>
        {cols.cost ? `${GAP}${'COST'.padStart(COST_W)}` : ''}
        {cols.tokens ? `${GAP}${'TOKENS'.padStart(TOKENS_W)}` : ''}
        {`${GAP}${'TOOK'.padStart(TOOK_W)}`}
      </Text>
    </Text>
  )
}

/** Selection is ONE continuous background across the whole row — never per-cell
 *  inverse video, which painted orange/magenta/green/yellow blocks. Semantic
 *  foreground colors stay; they remain legible on the warm dark tint. */
function TreeRow({ row, cols, selected, focused }: {
  row: DisplayRow; cols: TreeColumns; selected: boolean; focused: boolean
}) {
  const bg = selected ? (focused ? theme.selBg : theme.selBgInactive) : undefined
  return (
    <Text backgroundColor={bg} wrap="truncate">
      <Text color={row.stepColor} bold={row.stepBold} dimColor={row.stepDim}>{row.step}</Text>
      {cols.cost && (
        <>
          <Text>{GAP}</Text>
          <Text color={theme.cost}>{row.cost.padStart(COST_W)}</Text>
        </>
      )}
      {cols.tokens && (
        <>
          <Text>{GAP}</Text>
          <Text dimColor>{row.tokens.padStart(TOKENS_W)}</Text>
        </>
      )}
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
// `nodes`, never from tree-model internals.
// ---------------------------------------------------------------------------

/** The structural nesting depth of a row — the same scale as `node.depth`,
 *  whether the row is a plain node, a fold (its members' depth), or an info
 *  row (one past its owning node's depth). */
function structuralDepth(row: DisplayRow, nodes: TraceTreeNode[]): number {
  if (row.kind === 'node') return row.node!.depth
  if (row.kind === 'fold') return row.members![0].depth
  if (row.key === 'info:waiting') return 1                 // always the root's only child
  const id = Number(row.key.slice('info:expired:'.length))
  const owner = nodes.find((n) => n.type !== 'request' && n.id === id)
  return (owner?.depth ?? 0) + 1
}

/** A node branch (trace/tool) is currently open iff the very next row is one
 *  of its children — depth exactly one past its own. Does NOT hold for folds
 *  (their members render at the same depth); use `isBranchOpen`. */
function isRowExpanded(rows: DisplayRow[], idx: number, nodes: TraceTreeNode[]): boolean {
  const next = rows[idx + 1]
  if (!next) return false
  return structuralDepth(next, nodes) === structuralDepth(rows[idx], nodes) + 1
}

function isBranchOpen(
  row: DisplayRow, rows: DisplayRow[], idx: number, nodes: TraceTreeNode[],
  expanded: Set<string>, collapsed: Set<string>,
): boolean {
  if (row.kind === 'fold') return expanded.has(row.key) && !collapsed.has(row.key)
  return isRowExpanded(rows, idx, nodes)
}

/** The row key of the structural parent of `row`, or null at the root. */
function parentKeyOf(row: DisplayRow, nodes: TraceTreeNode[]): string | null {
  if (row.key === 'info:waiting') return nodes[0] ? rowKey(nodes[0]) : null
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
