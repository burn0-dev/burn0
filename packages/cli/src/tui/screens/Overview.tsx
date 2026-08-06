import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtNum, fmtMs, fmtTok } from '../../format.js'
import { G } from '../glyphs.js'
import { useFooter } from '../footer.js'
import type { OverviewReturnState } from '../routes.js'

// Layout mirrors the refined-overview mock (2026-08-05): open metric columns
// separated by │ rules instead of bordered cards, ─ rules between sections,
// and one DEPENDENCIES list with AI PROVIDERS / API SERVICES group labels.

const WINDOWS: { label: string; days: query.WindowDays }[] = [
  { label: 'Today', days: 0 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
]

/** Hide P95 first, then ERR — never provider/service, cost, or calls. */
function tableCols(columns: number): ColDef[] {
  const cols: ColDef[] = [
    { label: 'Provider / Service', grow: true, width: 16 },
    { label: 'Cost', width: 11, align: 'right' },
    { label: 'Calls', width: 9, align: 'right' },
  ]
  if (columns >= 58) cols.push({ label: 'Err', width: 7, align: 'right' })
  if (columns >= 72) cols.push({ label: 'P95', width: 9, align: 'right' })
  return cols
}

type Focus = 'none' | 'window' | 'rows'

interface Metric { label: string; value: string; color?: string; detail?: string }

function llmMetrics(d: query.OverviewDashboard): Metric[] {
  if (d.llmCalls === 0) {
    return ['LLM spend', 'Most expensive', 'LLM calls', 'Tokens']
      .map((label) => ({ label, value: '—', detail: 'No LLM requests' }))
  }
  const m = d.mostExpensiveModel
  return [
    {
      label: 'LLM spend',
      value: d.llmSpendUsd == null ? '—' : fmtUsd(d.llmSpendUsd),
      color: theme.cost,
      detail: d.llmPricedCalls === 0
        ? 'No priced calls'
        : `priced ${fmtNum(d.llmPricedCalls)} / ${fmtNum(d.llmCalls)} calls`,
    },
    {
      label: 'Most expensive',
      value: m ? m.model : '—',
      detail: m ? `${fmtUsd(m.costUsd)} · ${Math.round(m.share * 100)}% of spend` : 'No priced model',
    },
    { label: 'LLM calls', value: fmtNum(d.llmCalls), detail: 'requests' },
    {
      label: 'Tokens',
      value: d.tokens == null ? '—' : fmtTok(d.tokens),
      detail: d.tokens == null
        ? 'No token usage reported'
        : `reported ${fmtNum(d.llmTokenReportingCalls)} / ${fmtNum(d.llmCalls)}`,
    },
  ]
}

function apiMetrics(d: query.OverviewDashboard): Metric[] {
  if (d.apiCalls === 0) {
    return ['API calls', 'Most used API', 'Failed requests', 'API P95']
      .map((label) => ({ label, value: '—', detail: 'No API requests' }))
  }
  const top = d.mostUsedApi
  return [
    { label: 'API calls', value: fmtNum(d.apiCalls), detail: 'requests' },
    {
      label: 'Most used API',
      value: top ? top.entity : '—',
      detail: top ? `${fmtNum(top.calls)} calls · ${Math.round(top.share * 100)}% of API traffic` : undefined,
    },
    d.failedApiCalls === 0
      ? { label: 'Failed requests', value: '0', detail: 'No failed requests' }
      : {
          label: 'Failed requests',
          value: fmtNum(d.failedApiCalls),
          color: theme.err,
          detail: d.apiErrorRate != null ? `${(d.apiErrorRate * 100).toFixed(1)}% of API calls` : undefined,
        },
    {
      label: 'API P95',
      value: d.apiP95LatencyMs == null ? '—' : fmtMs(d.apiP95LatencyMs),
      color: d.apiP95LatencyMs == null ? undefined : theme.warn,
      detail: d.apiP95LatencyMs == null ? 'No latency reported' : 'slow-tail latency',
    },
  ]
}

function SectionRule({ width }: { width: number }) {
  return <Text color={theme.rule}>{'─'.repeat(Math.max(0, width))}</Text>
}

function MetricsSection({ title, metrics, width, perRow, showDetail }: {
  title: string; metrics: Metric[]; width: number; perRow: number; showDetail: boolean
}) {
  const chunks: Metric[][] = []
  for (let i = 0; i < metrics.length; i += perRow) chunks.push(metrics.slice(i, i + perRow))
  const lines = showDetail ? 3 : 2
  return (
    <Box flexDirection="column">
      <SectionRule width={width} />
      <Text bold color={theme.accentSoft}>{title}</Text>
      {chunks.map((chunk, ci) => {
        const colW = Math.max(8, Math.floor((width - 3 * (chunk.length - 1)) / chunk.length))
        return (
          <Box key={ci}>
            {chunk.map((m, i) => (
              <React.Fragment key={m.label}>
                {i > 0 && (
                  <Box flexDirection="column" marginX={1}>
                    {Array.from({ length: lines }, (_, l) => (
                      <Text key={l} color={theme.rule}>│</Text>
                    ))}
                  </Box>
                )}
                <Box width={colW} flexDirection="column">
                  <Text color={theme.label} wrap="truncate">{m.label}</Text>
                  <Text bold color={m.color ?? theme.textBright} wrap="truncate">{m.value}</Text>
                  {showDetail && <Text color={theme.detail} wrap="truncate">{m.detail ?? ' '}</Text>}
                </Box>
              </React.Fragment>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

export function OverviewScreen({ db, scope, onSubFocus, windowDays, onWindowChange, restore, onOpenEntity }: {
  db: StorageDriver
  scope?: Scope
  onSubFocus?: (focused: boolean) => void
  windowDays: query.WindowDays
  onWindowChange: (d: query.WindowDays) => void
  restore?: OverviewReturnState
  onOpenEntity: (row: query.OverviewEntityRow, state: OverviewReturnState) => void
}) {
  const win = Math.max(0, WINDOWS.findIndex((w) => w.days === windowDays))
  const msgLabel = WINDOWS[win].label.toLowerCase()
  const scopeKey = `${scope?.projectIds?.join(',') ?? '*'}|${scope?.services?.join(',') ?? '*'}`
  const deps = [windowDays, scopeKey]

  const dash = usePoll(() => query.overviewDashboard(db, { windowDays, scope }), 1000, deps)
  const entities = usePoll(() => query.overviewEntities(db, { windowDays, scope }), 1000, deps)

  // Returning from a drill-down: re-find the stored KEY in fresh data; the
  // stored index is only the fallback for a row that disappeared.
  const [cursor, setCursor] = useState(() => {
    if (!restore) return 0
    const i = restore.selectedEntity
      ? entities.findIndex((e) =>
          e.entity === restore.selectedEntity!.entity && e.entityClass === restore.selectedEntity!.entityClass)
      : -1
    return i >= 0 ? i : Math.max(0, Math.min(restore.fallbackCursor, entities.length - 1))
  })
  const [focus, setFocusState] = useState<Focus>(restore ? 'rows' : 'none')
  const setFocus = (f: Focus) => {
    setFocusState(f)
    onSubFocus?.(f !== 'none')
  }
  useEffect(() => {
    if (restore) onSubFocus?.(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { columns, rows: termRows } = useTermSize()
  const width = columns - 2
  const cols = tableCols(columns)
  const widths = colWidths(width, cols)
  const fourWide = columns >= 100
  const showDetail = termRows >= 20
  const perRow = fourWide ? 4 : 2

  const metricLines = showDetail ? 3 : 2
  const sectionH = 2 + (fourWide ? 1 : 2) * metricLines // rule + heading + metric rows
  const chrome = 5 /* App shell */ + 1 /* controls */ + 2 * sectionH + 3 /* list rule + title + header */
  const maxRows = Math.max(3, termRows - chrome)

  // One flat list — LLM entities first (by cost), then API (by calls); the
  // ◆/◇ glyph beside each name says which is which.
  const rowCount = entities.length
  const at = Math.min(cursor, Math.max(0, rowCount - 1))
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, rowCount - maxRows))

  useFooter(
    focus === 'rows' ? 'q quit · tab screens · ↑↓ select · enter details · esc back'
      : focus === 'window' ? 'q quit · tab screens · ←→ window · ↓ select · esc back'
        : 'q quit · tab screens · ↓ focus',
  )

  useInput((_input, key) => {
    if (focus === 'none') {
      if (key.downArrow) setFocus('window')
      return
    }
    if (focus === 'window') {
      if (key.rightArrow) onWindowChange(WINDOWS[(win + 1) % WINDOWS.length].days)
      if (key.leftArrow) onWindowChange(WINDOWS[(win + WINDOWS.length - 1) % WINDOWS.length].days)
      if (key.downArrow && rowCount > 0) setFocus('rows')
      if (key.upArrow || key.escape) setFocus('none')
      return
    }
    // focus === 'rows'
    if (key.upArrow) {
      if (at === 0) setFocus('window')
      else setCursor(at - 1)
    }
    if (key.downArrow) setCursor(Math.min(rowCount - 1, at + 1))
    if (key.pageUp) setCursor(Math.max(0, at - maxRows))
    if (key.pageDown) setCursor(Math.min(rowCount - 1, at + maxRows))
    if (key.escape) setFocus('none')
    if (key.return && entities[at]) {
      onOpenEntity(entities[at], {
        windowDays,
        selectedEntity: { entity: entities[at].entity, entityClass: entities[at].entityClass },
        fallbackCursor: at,
        scroll: start,
      })
    }
  })

  const empty = dash.llmCalls === 0 && dash.apiCalls === 0

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.muted}>{'WINDOW '}</Text>
        {WINDOWS.map((w, i) => (
          <Text
            key={w.label}
            bold={i === win}
            inverse={focus === 'window' && i === win}
            backgroundColor={i === win && focus !== 'window' ? theme.winBg : undefined}
            color={i === win ? theme.accentSoft : theme.detail}
          >
            {` ${w.label} `}
          </Text>
        ))}
        <Box flexGrow={1} justifyContent="flex-end">
          <Text color={theme.muted}>● Updated just now</Text>
        </Box>
      </Box>
      {empty ? (
        <Box marginTop={1}>
          <Text color={theme.detail}>{`No requests in ${msgLabel}${windowDays !== 30 ? ' — try 30d.' : '.'}`}</Text>
        </Box>
      ) : (
        <>
          <MetricsSection
            title="LLM ACTIVITY" metrics={llmMetrics(dash)}
            width={width} perRow={perRow} showDetail={showDetail}
          />
          <MetricsSection
            title="API HEALTH" metrics={apiMetrics(dash)}
            width={width} perRow={perRow} showDetail={showDetail}
          />
          <Box flexDirection="column">
            <SectionRule width={width} />
            <Box>
              <Text bold color={theme.accentSoft}>DEPENDENCIES</Text>
              <Box flexGrow={1} justifyContent="flex-end">
                <Text color={theme.muted}>↑↓ select · enter details</Text>
              </Box>
            </Box>
            <TableHeader cols={cols} widths={widths} />
            {entities.slice(start, start + maxRows).map((row, i) => (
              <TableRow
                key={`${row.entityClass}:${row.entity}`}
                cols={cols}
                widths={widths}
                selected={focus === 'rows' && start + i === at}
                selectedBg={theme.selBg}
                cells={rowCells(row, cols.length, focus === 'rows' && start + i === at)}
              />
            ))}
          </Box>
        </>
      )}
    </Box>
  )
}

function rowCells(e: query.OverviewEntityRow, colCount: number, selected = false) {
  const llm = e.entityClass === 'llm'
  const cells = [
    // The selected name goes accent-orange: the bg tint alone is too quiet in a
    // 1-line row to say "press enter to open".
    { text: `${llm ? G.llm : G.api} ${e.entity}`, color: selected ? theme.accentSoft : theme.name, bold: true },
    // API cost is out of scope for this screen — always a gap, never $0.00.
    { text: llm ? fmtUsd(e.costUsd) : '—', color: llm && e.costUsd != null ? theme.cost : undefined },
    { text: fmtNum(e.calls) },
    { text: `${(e.errorRate * 100).toFixed(1)}%`, color: e.errorRate > 0 ? theme.err : undefined },
    { text: fmtMs(e.p95LatencyMs) },
  ]
  return cells.slice(0, colCount)
}
