import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type StorageDriver } from '@burn0/core'
import type { TraceTreeNode } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme } from '../theme.js'
import { NAV, useFooter } from '../footer.js'
import { buildRows, rowKey, type DisplayRow } from '../tree-model.js'
import { TraceDetail } from './TraceDetail.js'
import { DebugScreen } from './Debug.js'

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

// One footer string per state (spec §4's tree / flat / payload / pruned) —
// `useFooter` below claims the line App renders; this screen no longer paints
// its own (that was the double-footer bug: App's stale tab-2 default sat
// above this screen's accurate one).
const FOOTER_TREE = `${NAV} · ↑↓ move · h/l fold · ⏎ open · f flat · esc back`
const FOOTER_FLAT = `${NAV} · ↑↓ move · h/l fold · ⏎ open · f tree · esc back`
const FOOTER_PAYLOAD = `${NAV} · esc back`
const FOOTER_PRUNED = 'q quit · esc back'

/** Pane math, pulled out pure so both the component and a regression test can
 *  pin it: two-pane's `pane` is 0.62 of `columns` (capped 98); single-pane
 *  gives the tree pane the whole row bar a 1-column margin — spec §2.5's own
 *  worked numbers are 140 cols → STEP 53 (two-pane) and `columns - 34`
 *  (single-pane), the latter only reachable with margin 1, not 2. */
export function computeLayout(columns: number): {
  twoPane: boolean; paneWidth: number; detailWidth: number; stepWidth: number
} {
  const twoPane = columns >= TWO_PANE_MIN_COLUMNS
  const paneWidth = twoPane ? Math.min(Math.floor(columns * 0.62), 98) : columns - 1
  const detailWidth = columns - paneWidth - 2
  const stepWidth = Math.max(1, paneWidth - (COST_W + TOKENS_W + TOOK_W + 6))
  return { twoPane, paneWidth, detailWidth, stepWidth }
}

export function TraceView({ db, traceId, columns: forced, now: forcedNow, onBack }: {
  db: StorageDriver
  traceId: number
  /** Override for tests and for callers that already measured. */
  columns?: number
  /** Override for tests — the clock `● LIVE`'s elapsed figure is measured
   *  against (spec §4). Defaults to the wall clock. */
  now?: number
  onBack: () => void
}) {
  const term = useTermSize()
  const columns = forced ?? term.columns
  const tree = usePoll(() => query.traceTree(db, traceId), 1000, [traceId])
  const nodes = tree?.nodes ?? []

  const [expanded, setExpanded] = useState(() => new Set<string>())
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const [flat, setFlat] = useState(false)
  const [cursorKey, setCursorKey] = useState<string | null>(null)
  // The payload screen as a child state (spec §4): `esc` unwinds it without
  // unmounting anything above, so `expanded`/`collapsed`/`cursorKey` are all
  // still exactly what they were. This replaces the old App-level
  // `selectedRequestId` swap for everything opened from inside this tree —
  // that swap remounted the whole screen stack on the way back, which is
  // what lost the tree in the first place.
  const [openRequestId, setOpenRequestId] = useState<number | null>(null)

  const { twoPane, paneWidth, detailWidth, stepWidth } = computeLayout(columns)

  const rows = useMemo(
    () => (tree ? buildRows({ tree, expanded, collapsed, stepWidth, flat, now: forcedNow ?? Date.now() }) : []),
    // `forcedNow` (not a raw `Date.now()` call) in the dep array: a fixed
    // override must never re-trigger this memo, and a live clock's own
    // "freshness" already comes from `tree`'s identity changing on every 1s
    // poll tick — this only needs to grab a current timestamp when it was
    // about to recompute anyway.
    [tree, expanded, collapsed, stepWidth, flat, forcedNow],
  )

  // Cursor resolution, run whenever `rows` itself changes (a poll rebuilding
  // the tree, or the user's own h/l/f changing what's visible) — precedence
  // matters:
  //   1. was the cursor on the LAST row before this change? Follow to the new
  //      last row, unconditionally. This must outrank identity: the row the
  //      cursor was on may still exist (just no longer last), and a live
  //      trace should keep tailing it regardless.
  //   2. otherwise, does the same key still exist? Keep it.
  //   3. otherwise, clamp to the nearest valid index.
  // `prevIndexRef`/`prevRowsRef` are NOT only updated here — see the tracking
  // effect below, which is what keeps "previous position" honest across pure
  // cursor moves (arrow keys) that never touch `rows` at all.
  const prevRowsRef = useRef<DisplayRow[]>([])
  const prevIndexRef = useRef<number>(-1)
  useEffect(() => {
    const prevRows = prevRowsRef.current
    const prevIndex = prevIndexRef.current
    let idx: number
    if (rows.length === 0) {
      idx = -1
    } else if (prevRows.length === 0) {
      idx = 0
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

  // Keep a live snapshot of "where the cursor is right now" after every
  // render — not only after a `rows` change — so the effect above always
  // resolves against the freshest position. Declared after the resolution
  // effect so, within one commit, resolution reads last render's snapshot
  // before this one overwrites it with the current render's.
  useEffect(() => {
    prevRowsRef.current = rows
    prevIndexRef.current = rows.length > 0 ? rows.findIndex((r) => r.key === cursorKey) : -1
  })

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
    // The payload screen owns nothing but `esc`: every tree key (arrows,
    // h/l/f/⏎) belongs to the row that was selected before it opened, and
    // must not touch `expanded`/`collapsed`/`cursorKey` while it's up.
    if (openRequestId != null) {
      if (key.escape) setOpenRequestId(null)
      return
    }
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
      // A leaf's ⏎ opens the payload in place — no fold-member exception (see
      // Task 10's judgment call 1): a folded call's payload is not less
      // openable than the same call unfolded.
      if (row.requestId != null) { setOpenRequestId(row.requestId); return }
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
        // Only jump to a parent the current mode actually renders — flat mode
        // has no structure rows, so a structural parent key would deselect
        // everything until the next poll (final-review F7).
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

  // One `useFooter` call, unconditional (rules of hooks), covering all four
  // states — must run before the pruned early return below, or the hook
  // count would differ between renders.
  const footerText = tree === null ? FOOTER_PRUNED
    : openRequestId != null ? FOOTER_PAYLOAD
      : flat ? FOOTER_FLAT : FOOTER_TREE
  useFooter(footerText)

  if (tree === null) {
    return (
      <Box flexDirection="column">
        <Text color={theme.warn}>
          Trace no longer in the database — pruned by retention while you were viewing it.
        </Text>
        <Text dimColor>esc returns to the list.</Text>
      </Box>
    )
  }

  if (openRequestId != null) {
    return <DebugScreen db={db} requestId={openRequestId} />
  }

  const selected = rows[at]

  const treePane = (
    <Box flexDirection="column" width={twoPane ? paneWidth : undefined}>
      <TreeHeader stepWidth={stepWidth} />
      {rows.slice(start, start + maxRows).map((r) => (
        <TreeRow key={r.key} row={r} selected={r.key === cursorKey} />
      ))}
    </Box>
  )

  return twoPane ? (
    // The width is stated, not inherited: the tree pane is sized from
    // `columns`, so the container must be laid out against the same number or
    // the detail pane silently gets whatever is left of a different width.
    <Box gap={2} width={columns}>
      {treePane}
      <Box flexDirection="column" width={detailWidth}>
        <TraceDetail
          row={selected} nodes={nodes} db={db}
          width={detailWidth} height={term.rows} now={forcedNow}
        />
      </Box>
    </Box>
  ) : treePane
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
  if (row.key === 'info:waiting') return 1                 // always the root's only child
  const id = Number(row.key.slice('info:expired:'.length))
  const owner = nodes.find((n) => n.type !== 'request' && n.id === id)
  return (owner?.depth ?? 0) + 1
}

/** A node branch (trace/tool) is currently open iff the very next row is one
 *  of its children — depth exactly one past its own. This does NOT hold for
 *  folds: a fold's members render at the SAME `node.depth` as the fold header
 *  (only their guide prefix deepens visually), so this check alone always
 *  reads an open fold as closed. Use `isBranchOpen` at call sites — it is the
 *  one that knows the difference. */
function isRowExpanded(rows: DisplayRow[], idx: number, nodes: TraceTreeNode[]): boolean {
  const next = rows[idx + 1]
  if (!next) return false
  return structuralDepth(next, nodes) === structuralDepth(rows[idx], nodes) + 1
}

/** Whether `row` (a branch — node or fold) is currently showing its children.
 *  Folds key directly off `expanded`/`collapsed` — tree-model's own
 *  `isFoldOpen` contract, which `DEFAULT_VISIBLE_DEPTH` never touches — rather
 *  than the rendered-depth heuristic `isRowExpanded` uses for node branches,
 *  which folds structurally defeat (see `isRowExpanded`'s comment). */
function isBranchOpen(
  row: DisplayRow, rows: DisplayRow[], idx: number, nodes: TraceTreeNode[],
  expanded: Set<string>, collapsed: Set<string>,
): boolean {
  if (row.kind === 'fold') return expanded.has(row.key) && !collapsed.has(row.key)
  return isRowExpanded(rows, idx, nodes)
}

/** The row key of the structural parent of `row`, or null at the root.
 *  Requests are always leaves in this schema, so a folded leaf's parent is
 *  never itself inside another fold — the scan is safe over the raw DFS
 *  order without re-deriving tree-model's internal parent index. */
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

// The detail pane lives in `TraceDetail.tsx` — five cards, one per row type,
// including the fold and info rows this screen's old label/value card could
// only render as a blank.
