import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import type { TraceListRow } from '@burn0/core'
import { usePoll } from '../hooks.js'
import { theme, statusColor, latencyColor } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { NAV, useFooter } from '../footer.js'
import { fmtUsd, fmtNum, fmtMs, fmtTime, fmtTokPair } from '../../format.js'
import { padCell, visWidth } from '../glyphs.js'
import { workspaceLayout, listColumns } from '../workspace-layout.js'
import type { Viewport } from '../App.js'
import { TracesScreen } from './Traces.js'
import { TraceView, PaneDivider, type TreeUiState } from './TraceView.js'
import { DebugScreen } from './Debug.js'

/** The LLM tab — a responsive trace workspace (spec 2026-08-06).
 *
 *  narrow  (<110 content cols): trace list ⏎→ full-width tree ⏎→ request detail
 *  medium  (110–159):           trace list ⏎→ tree│inspector  ⏎→ request detail
 *  wide    (≥160):              persistent  list│tree│inspector, ←→ moves focus
 *
 *  Selection is IDENTITY-based: the cursor keys on `t{traceId}`/`r{requestId}`,
 *  never a bare index — a trace inserted by the 1s poll must not silently move
 *  the selection. The one exception is deliberate: a cursor sitting on the
 *  newest row is following the tail and moves with it. */

type PaneFocus = 'list' | 'tree' | 'inspector'

const idKey = (r: TraceListRow): string => (r.id != null ? `t${r.id}` : `r${r.requestId}`)

export function TraceListScreen({ db, scope, viewport, onSubFocus, onOpenRequest }: {
  db: StorageDriver
  scope?: Scope
  viewport: Viewport
  onSubFocus?: (focused: boolean) => void
  onOpenRequest: (id: number) => void
}) {
  const scopeKey = `${scope?.projectIds?.join(',') ?? '*'}|${scope?.services?.join(',') ?? '*'}`
  const rows = usePoll(() => query.traceList(db, { scope, limit: 200 }), 1000, [scopeKey])
  const layout = workspaceLayout(viewport.columns)
  const wide = layout.mode === 'wide'

  const [cursorKey, setCursorKey] = useState<string | null>(null)
  const [openTrace, setOpenTrace] = useState<number | null>(null)  // narrow/medium navigation
  const [focus, setFocus] = useState<PaneFocus>('list')
  const [flat, setFlat] = useState(false)
  const [treeFlat, setTreeFlat] = useState(false)
  const [openRequestId, setOpenRequestId] = useState<number | null>(null)
  const uiCache = useRef(new Map<number, TreeUiState>())
  const prevNewest = useRef<string | null>(null)
  const lastIndex = useRef(0)

  // Identity resolution across polls: keep the selected trace by KEY; follow
  // the tail only when the cursor was already on the newest row; fall back to
  // the previous index only when the row disappeared entirely.
  useEffect(() => {
    if (rows.length === 0) {
      if (cursorKey != null) setCursorKey(null)
      prevNewest.current = null
      return
    }
    const newest = idKey(rows[0])
    if (cursorKey == null) setCursorKey(newest)
    else if (cursorKey === prevNewest.current && newest !== cursorKey) setCursorKey(newest)
    else if (!rows.some((r) => idKey(r) === cursorKey)) {
      setCursorKey(idKey(rows[Math.min(lastIndex.current, rows.length - 1)]))
    }
    prevNewest.current = newest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const at = Math.max(0, rows.findIndex((r) => idKey(r) === cursorKey))
  useEffect(() => { lastIndex.current = at })
  const here = rows[at]

  // The workspace owns ←→ whenever panes are on screen — App must not treat
  // them as tab switches while they mean "move pane focus".
  const ownsArrows = wide || openTrace != null
  useEffect(() => {
    onSubFocus?.(ownsArrows)
    return () => onSubFocus?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownsArrows])

  const traceOpen = wide ? (here?.id ?? null) : openTrace
  const showingPanes = wide || openTrace != null

  const moveCursor = (delta: number) => {
    if (rows.length === 0) return
    const next = Math.max(0, Math.min(rows.length - 1, at + delta))
    setCursorKey(idKey(rows[next]))
  }

  useInput((input, key) => {
    if (openRequestId != null) {
      if (key.escape) setOpenRequestId(null)
      return                                // detail screen owns everything else
    }

    // ---- wide: three panes, ←→ moves focus -----------------------------------
    if (wide) {
      if (key.leftArrow) {
        setFocus((f) => (f === 'inspector' ? 'tree' : 'list'))
        return
      }
      if (key.rightArrow) {
        setFocus((f) => (f === 'list' ? 'tree' : 'inspector'))
        return
      }
      if (key.escape) {
        setFocus((f) => (f === 'inspector' ? 'tree' : 'list'))
        return
      }
      if (focus === 'list') {
        if (key.upArrow) moveCursor(-1)
        if (key.downArrow) moveCursor(1)
        if (key.pageUp) moveCursor(-listViewRows(viewport.rows))
        if (key.pageDown) moveCursor(listViewRows(viewport.rows))
        if (key.return && here) {
          if (here.id == null && here.requestId != null) setOpenRequestId(here.requestId)
          else if (here.id != null) setFocus('tree')
        }
      }
      return                                // tree/inspector keys live in TraceView
    }

    // ---- narrow / medium ------------------------------------------------------
    if (openTrace != null) {
      if (key.escape) {
        if (focus === 'inspector') setFocus('tree')
        else { setOpenTrace(null); setFocus('list') }
        return
      }
      if (layout.inspector != null) {
        if (key.leftArrow) { setFocus('tree'); return }
        if (key.rightArrow) { setFocus('inspector'); return }
      }
      return
    }

    if (input === 'f') setFlat((v) => !v)
    if (key.upArrow) moveCursor(-1)
    if (key.downArrow) moveCursor(1)
    if (key.return && here) {
      if (here.id == null && here.requestId != null) setOpenRequestId(here.requestId)
      else if (here.id != null) { setOpenTrace(here.id); setFocus('tree') }
    }
  })

  // ---- footer ----------------------------------------------------------------
  const footer = openRequestId != null ? false                       // detail claims its own
    : wide
      ? focus === 'list' ? `${NAV} · ↑↓ select · →/⏎ tree`
        : focus === 'tree' ? `↑↓ move · h/l fold · ⏎ open · f ${treeFlat ? 'tree' : 'flat'} · ←→ panes · esc back`
          : '↑↓ scroll · ⏎ full detail · ←→ panes · esc back'
      : openTrace != null
        ? traceOpenFooter(layout.inspector != null, focus, treeFlat)
        : flat
          ? `${NAV} · ↑↓ select · ⏎ open request · f trace list`
          : `${NAV} · ↑↓ select · ${here && here.id == null ? '⏎ open' : '⏎ open trace'} · f flat`
  useFooter(footer)

  // ---- render ----------------------------------------------------------------
  if (openRequestId != null) {
    return <DebugScreen db={db} requestId={openRequestId} viewport={viewport} />
  }

  if (!wide && openTrace == null) {
    if (flat) return <TracesScreen db={db} scope={scope} llm onOpen={onOpenRequest} />
    return (
      <FullList
        rows={rows} at={at} width={viewport.columns} height={viewport.rows}
        focused
      />
    )
  }

  if (!wide) {
    // narrow: full-width tree · medium: tree│inspector
    return (
      <TraceView
        key={openTrace}
        db={db} traceId={openTrace!}
        width={viewport.columns} height={viewport.rows - 1}
        treeWidth={layout.inspector != null ? layout.tree : viewport.columns}
        inspectorWidth={layout.inspector}
        focus={focus === 'list' ? 'tree' : focus}
        cache={uiCache}
        onOpenRequest={setOpenRequestId}
        onFold={setTreeFlat}
      />
    )
  }

  // wide: persistent three-pane workspace
  const paneRows = viewport.rows - 1
  return (
    <Box width={viewport.columns}>
      <CompactList
        rows={rows} at={at} width={layout.list!} height={paneRows}
        focused={focus === 'list'}
      />
      <PaneDivider rows={paneRows + 1} />
      {traceOpen != null ? (
        <TraceView
          key={traceOpen}
          db={db} traceId={traceOpen}
          width={layout.tree + 1 + layout.inspector!}
          height={paneRows}
          treeWidth={layout.tree}
          inspectorWidth={layout.inspector}
          focus={focus === 'list' ? 'none' : focus}
          cache={uiCache}
          onOpenRequest={setOpenRequestId}
          onFold={setTreeFlat}
        />
      ) : (
        <Box flexDirection="column" width={layout.tree + 1 + layout.inspector!}>
          <Text dimColor>{rows.length === 0 ? 'No LLM calls yet.'
            : here?.requestId != null ? 'untraced call — ⏎ opens the request' : 'select a trace'}</Text>
        </Box>
      )}
    </Box>
  )
}

function traceOpenFooter(hasInspector: boolean, focus: PaneFocus, treeFlat: boolean): string {
  if (!hasInspector) return `${NAV} · ↑↓ move · h/l fold · ⏎ open · f ${treeFlat ? 'tree' : 'flat'} · esc back`
  return focus === 'inspector'
    ? '↑↓ scroll · ⏎ full detail · ←→ panes · esc back'
    : `↑↓ move · h/l fold · ⏎ open · f ${treeFlat ? 'tree' : 'flat'} · ←→ panes · esc back`
}

/** Rows the full-width list can show below its header. */
function listViewRows(contentRows: number): number {
  return Math.max(3, contentRows - 1)
}

// ---------------------------------------------------------------------------
// Full-width list (narrow/medium) — responsive column subsets. A column set is
// only offered when it provably fits; values and headers decide together.
// ---------------------------------------------------------------------------

function buildCols(width: number): ColDef[] {
  const v = listColumns(width)
  const cols: ColDef[] = []
  if (v.time) cols.push({ label: 'Time', width: 8 })
  cols.push({ label: 'Trace', grow: true, width: 20 })
  if (v.cost) cols.push({ label: 'Cost', width: 10, align: 'right' })
  if (v.calls) cols.push({ label: 'Calls', width: 6, align: 'right' })
  if (v.tokens) cols.push({ label: 'Tokens in→out', width: 15, align: 'right' })
  if (v.dur) cols.push({ label: 'Dur', width: 7, align: 'right' })
  if (v.steps) cols.push({ label: 'Steps', width: 10 })
  return cols
}

function FullList({ rows, at, width, height, focused }: {
  rows: TraceListRow[]; at: number; width: number; height: number; focused: boolean
}) {
  const cols = buildCols(width)
  const v = listColumns(width)
  const widths = colWidths(width, cols)
  const maxRows = listViewRows(height)
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, rows.length - maxRows))

  if (rows.length === 0) return <Text dimColor>No LLM calls yet.</Text>

  return (
    <Box flexDirection="column" width={width}>
      <TableHeader cols={cols} widths={widths} />
      {rows.slice(start, start + maxRows).map((r, i) => (
        <TableRow
          key={idKey(r)}
          cols={cols}
          widths={widths}
          selected={start + i === at}
          selectedBg={focused ? theme.selBg : theme.selBgInactive}
          cells={cells(r, v)}
        />
      ))}
    </Box>
  )
}

function cells(r: TraceListRow, v: ReturnType<typeof listColumns>) {
  const out = []
  if (v.time) out.push({ text: fmtTime(r.startedAt), dim: true })
  out.push({
    text: `${r.name}${r.incomplete ? ' ⚠' : ''}`,
    color: r.id == null ? theme.model : r.status != null ? statusColor(r.status) : undefined,
    bold: r.id != null,
  })
  // pricedCalls 0 means nothing in this trace resolved to a price
  if (v.cost) out.push({ text: r.pricedCalls > 0 ? fmtUsd(r.costUsd) : '—', color: theme.cost })
  if (v.calls) out.push({ text: fmtNum(r.calls) })
  if (v.tokens) out.push({ text: r.tokenCalls > 0 ? fmtTokPair(r.tokensIn, r.tokensCached, r.tokensOut, true) : '—', dim: true })
  if (v.dur) out.push({ text: fmtMs(r.durationMs), color: latencyColor(r.durationMs) })
  // ◆ LLM, ◇ API — retrieve-then-answer reads as ◆◇◆◇; a long ◆◆◆◆◆ is a loop
  if (v.steps) out.push({ text: r.steps, dim: true })
  return out
}

// ---------------------------------------------------------------------------
// Compact list (wide left pane) — two-line rows, no card. Status is reserved
// before the name truncates; the second line is dim supporting information.
// ---------------------------------------------------------------------------

function CompactList({ rows, at, width, height, focused }: {
  rows: TraceListRow[]; at: number; width: number; height: number; focused: boolean
}) {
  const perRow = 2
  const maxTraces = Math.max(1, Math.floor(height / perRow))
  const start = at < maxTraces ? 0 : Math.min(at - maxTraces + 1, Math.max(0, rows.length - maxTraces))
  const shown = rows.slice(start, start + maxTraces)

  const headCount = `${start + 1}–${Math.min(start + maxTraces, rows.length)} of ${rows.length}`
  const head = visWidth(`TRACES  ${headCount}`) <= width ? headCount : ''

  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate">
        <Text bold color={focused ? theme.accentSoft : undefined} dimColor={!focused}>TRACES</Text>
        {head && <Text dimColor>{`  ${head}`}</Text>}
      </Text>
      {rows.length === 0 && <Text dimColor>No LLM calls yet.</Text>}
      {shown.map((r, i) => (
        <CompactRow
          key={idKey(r)} row={r} width={width}
          selected={start + i === at} focused={focused}
        />
      ))}
    </Box>
  )
}

function CompactRow({ row: r, width, selected, focused }: {
  row: TraceListRow; width: number; selected: boolean; focused: boolean
}) {
  const bg = selected ? (focused ? theme.selBg : theme.selBgInactive) : undefined
  // Status is semantic and reserved: failure red, incomplete yellow, live dim ●,
  // success quiet — a bright green tick on every healthy row would be noise.
  const failed = r.status != null && r.status >= 400
  const status = r.incomplete ? '⚠' : failed ? String(r.status) : r.endedAt == null && r.id != null ? '●' : '✓'
  const statusCol = r.incomplete ? theme.warn : failed ? theme.err : undefined

  const time = `${fmtTime(r.startedAt).slice(0, 5)}  `
  const nameBudget = Math.max(1, width - visWidth(time) - visWidth(status) - 1)
  const line2 = `${r.pricedCalls > 0 ? fmtUsd(r.costUsd) : '—'} · ${fmtMs(r.durationMs)}${r.steps ? ` · ${r.steps}` : ''}`

  return (
    <Box flexDirection="column">
      <Text backgroundColor={bg} wrap="truncate">
        <Text dimColor>{time}</Text>
        <Text bold={r.id != null} color={r.id == null ? theme.model : undefined}>
          {padCell(r.name, nameBudget)}
        </Text>
        <Text> </Text>
        <Text color={statusCol} dimColor={statusCol == null}>{status}</Text>
      </Text>
      <Text backgroundColor={bg} wrap="truncate">
        <Text dimColor>{padCell(`       ${line2}`, width)}</Text>
      </Text>
    </Box>
  )
}
