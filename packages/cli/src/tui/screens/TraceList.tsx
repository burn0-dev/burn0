import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import type { TraceListRow } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme, statusColor, latencyColor } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { NAV, useFooter } from '../footer.js'
import { fmtUsd, fmtNum, fmtMs, fmtTime, fmtTokPair } from '../../format.js'
import { TracesScreen } from './Traces.js'
import { TraceView } from './TraceView.js'

/** The LLM screen: a chronological list of traces, newest first, one uniform row
 *  each. An earlier draft inlined each trace's steps under its row; it failed
 *  because a tree inlined into a list breaks column alignment — steps sit at
 *  varying indents, so no numeric column scans vertically. The tree gets its own
 *  surface (`TraceView`); one trace per row scans at any length. */

const COLS: ColDef[] = [
  { label: 'Time', width: 8 },
  { label: 'Trace', grow: true, width: 22 },
  { label: 'Cost', width: 10, align: 'right' },
  { label: 'Calls', width: 6, align: 'right' },
  { label: 'Tokens in→out', width: 15, align: 'right' },
  { label: 'Dur', width: 7, align: 'right' },
  { label: 'Steps', width: 10 },
]

export function TraceListScreen({ db, scope, onOpenRequest }: {
  db: StorageDriver
  scope?: Scope
  onOpenRequest: (id: number) => void
}) {
  const scopeKey = `${scope?.projectIds?.join(',') ?? '*'}|${scope?.services?.join(',') ?? '*'}`
  const rows = usePoll(() => query.traceList(db, { scope, limit: 200 }), 1000, [scopeKey])
  const [cursor, setCursor] = useState(0)
  const [flat, setFlat] = useState(false)
  const [openTrace, setOpenTrace] = useState<number | null>(null)
  const { columns, rows: termRows } = useTermSize()

  const widths = colWidths(columns - 2, COLS)
  const maxRows = Math.max(3, termRows - 9)
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, rows.length - maxRows))

  useInput((input, key) => {
    if (openTrace != null) return          // TraceView owns the keys while open
    if (input === 'f') setFlat((v) => !v)
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow) setCursor((c) => Math.min(rows.length - 1, c + 1))
    if (key.return) {
      const here = rows[at]
      if (!here) return
      // An untraced call has no tree to open — go straight to the request.
      if (here.id == null && here.requestId != null) onOpenRequest(here.requestId)
      else if (here.id != null) setOpenTrace(here.id)
    }
  })

  // This screen owns the footer for every one of its own sub-states.
  // Deferred (`false`) ONLY when a trace is open — TraceView is mounted then
  // and claims the line itself (child-before-parent effect ordering means
  // its claim would win anyway, but `false` also means THIS component never
  // even tries, so there is no stale text sitting around from before the
  // trace opened).
  //
  // review round 1, Finding 2: the flat sub-view (TracesScreen, per-call rows)
  // used to fall through to `false` here too, on the theory that it would
  // pick up the plain trace-list text as a "reasonable enough" default. It
  // doesn't — `useFooter(false)` only skips SETTING, it never releases a
  // previous claim, and this component never unmounts when `flat` flips (it
  // is the same instance, just choosing what to render), so the stale
  // "⏎ open trace · f flat" from the list view stayed up verbatim while ⏎
  // actually opened a request payload and `f` returned to the trace list —
  // both keys the visible footer described wrongly. The flat sub-view must
  // claim its own accurate string, not borrow the list's.
  const here = rows[at]
  const listFooter = `${NAV} · ↑↓ select · ${here && here.id == null ? '⏎ open' : '⏎ open trace'} · f flat`
  const flatFooter = `${NAV} · ↑↓ select · ⏎ open request · f trace list`
  useFooter(openTrace != null ? false : flat ? flatFooter : listFooter)

  if (openTrace != null) {
    return (
      <TraceView
        db={db}
        traceId={openTrace}
        onBack={() => setOpenTrace(null)}
      />
    )
  }

  if (flat) return <TracesScreen db={db} scope={scope} llm onOpen={onOpenRequest} />
  if (rows.length === 0) return <Text dimColor>No LLM calls yet.</Text>

  return (
    <Box flexDirection="column">
      <TableHeader cols={COLS} widths={widths} />
      {rows.slice(start, start + maxRows).map((r, i) => (
        <TableRow
          key={r.id != null ? `t${r.id}` : `r${r.requestId}`}
          cols={COLS}
          widths={widths}
          selected={start + i === at}
          cells={cells(r)}
        />
      ))}
    </Box>
  )
}

function cells(r: TraceListRow) {
  return [
    { text: fmtTime(r.startedAt), dim: true },
    {
      text: `${r.name}${r.incomplete ? ' ⚠' : ''}`,
      color: r.id == null ? theme.model : r.status != null ? statusColor(r.status) : undefined,
      bold: r.id != null,
    },
    // pricedCalls 0 means nothing in this trace resolved to a price
    { text: r.pricedCalls > 0 ? fmtUsd(r.costUsd) : '—', color: theme.cost },
    { text: fmtNum(r.calls) },
    { text: r.tokenCalls > 0 ? fmtTokPair(r.tokensIn, r.tokensCached, r.tokensOut, true) : '—', dim: true },
    { text: fmtMs(r.durationMs), color: latencyColor(r.durationMs) },
    // ◆ LLM, ◇ API — retrieve-then-answer reads as ◆◇◆◇; a long ◆◆◆◆◆ is a loop
    { text: r.steps, dim: true },
  ]
}
