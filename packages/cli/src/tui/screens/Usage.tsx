import React, { useState } from 'react'
import { Box, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import type { UsageNode } from '@burn0/core'
import { usePoll, useTermSize } from '../hooks.js'
import { theme } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtUsd, fmtNum, fmtBytes, fmtTok, CACHE_MARK } from '../../format.js'

const COLS: ColDef[] = [
  { label: 'Vendor / service / endpoint', grow: true, width: 24 },
  { label: 'Calls', width: 9, align: 'right' },
  { label: 'In', width: 11, align: 'right' },
  { label: 'Out', width: 11, align: 'right' },
  { label: 'Cost', width: 11, align: 'right' },
  { label: 'Err', width: 6, align: 'right' },
]

interface Row {
  node: UsageNode
  depth: number
  open: boolean
}

/** Depth 0 lands expanded — one level of children is the useful landing view.
 *  `toggled` holds only the keys the user flipped away from that default, so it
 *  survives the poll refresh without needing to be seeded from the data. */
function flatten(nodes: UsageNode[], toggled: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const node of nodes) {
    const open = node.children.length > 0 && ((depth === 0) !== toggled.has(node.key))
    out.push({ node, depth, open })
    if (open) flatten(node.children, toggled, depth + 1, out)
  }
  return out
}

export function UsageScreen({ db, scope }: { db: StorageDriver; scope?: Scope }) {
  const tree = usePoll(() => query.usageTree(db, { scope }), 1000, [scope?.projectIds?.[0], scope?.services?.[0]])
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const { columns, rows } = useTermSize()

  const flat = flatten(tree, toggled)
  const widths = colWidths(columns - 2, COLS)
  const maxRows = Math.max(3, rows - 8)
  const at = Math.min(cursor, Math.max(0, flat.length - 1))
  // Data is never trimmed: the window slides so the cursor always stays visible.
  const start = at < maxRows ? 0 : Math.min(at - maxRows + 1, Math.max(0, flat.length - maxRows))

  const toggle = (key: string, want: boolean | null) => {
    setToggled((prev) => {
      const row = flat.find((r) => r.node.key === key)
      if (!row || row.node.children.length === 0) return prev
      if (want != null && want === row.open) return prev
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow) setCursor((c) => Math.min(flat.length - 1, c + 1))
    const here = flat[at]?.node.key
    if (!here) return
    if (key.return) toggle(here, null)
    if (input === 'l') toggle(here, true)
    if (input === 'h') toggle(here, false)
  })

  return (
    <Box flexDirection="column">
      <TableHeader cols={COLS} widths={widths} />
      {flat.slice(start, start + maxRows).map((r, i) => (
        <TableRow
          key={r.node.key}
          cols={COLS}
          widths={widths}
          selected={start + i === at}
          cells={cells(r)}
        />
      ))}
    </Box>
  )
}

function cells(r: Row) {
  const n = r.node
  const marker = n.children.length === 0 ? ' ' : r.open ? '▾' : '▸'
  return [
    {
      text: `${'  '.repeat(r.depth)}${marker} ${n.label}`,
      color: n.kind === 'endpoint' ? undefined : n.llm ? theme.entityLlm : theme.accent,
      bold: r.depth === 0,
    },
    { text: fmtNum(n.calls) },
    { text: volume(n, 'in'), dim: true },
    { text: volume(n, 'out'), dim: true },
    // pricedCalls 0 means nothing under this node resolved to a price — a gap, not free
    { text: n.pricedCalls > 0 ? fmtUsd(n.costUsd) : '—', color: theme.cost },
    { text: String(n.errors), color: n.errors > 0 ? theme.err : theme.dim },
  ]
}

/** LLM rows are metered in tokens, everything else in bytes. Either can be
 *  unreported — a provider that sent no usage block, or the undici capture path
 *  that never sees bodies — and unreported renders as a gap, not as 0. */
function volume(n: UsageNode, dir: 'in' | 'out'): string {
  if (n.llm) {
    if (n.tokenCalls === 0) return '—'
    if (dir === 'out') return fmtTok(n.tokensOut)
    return fmtTok(n.tokensIn) + ((n.tokensCached ?? 0) > 0 ? CACHE_MARK : '')
  }
  const known = dir === 'in' ? n.bytesInKnown : n.bytesOutKnown
  return fmtBytes(known > 0 ? (dir === 'in' ? n.bytesIn : n.bytesOut) : null)
}
