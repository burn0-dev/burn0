import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { query, type StorageDriver, type TraceRow } from '@burn0/core'
import { useTermSize } from '../hooks.js'
import { theme, statusColor, latencyColor } from '../theme.js'
import { TableHeader, TableRow, colWidths, type ColDef } from '../ui.js'
import { fmtMs, fmtAgo } from '../../format.js'

const KEEP = 100

const COLS: ColDef[] = [
  { label: 'Time', width: 9 },
  { label: 'St', width: 4 },
  { label: 'Method', width: 7 },
  { label: 'Entity', width: 16 },
  { label: 'Endpoint', grow: true, width: 24 },
  { label: 'Latency', width: 9, align: 'right' },
]

export function NetworkScreen({ db, onOpen }: { db: StorageDriver; onOpen: (id: number) => void }) {
  const [trs, setTrs] = useState<TraceRow[]>(() => {
    try {
      return [...query.traces(db, { llm: true, limit: 10 }), ...query.traces(db, { llm: false, limit: 10 })]
        .sort((a, b) => a.id - b.id)
    } catch {
      return []
    }
  })
  const [cursor, setCursor] = useState(0)
  const lastId = useRef(trs.length ? trs[trs.length - 1].id : 0)
  const { columns, rows } = useTermSize()
  const widths = colWidths(columns - 2, COLS)
  const show = Math.max(5, rows - 8)

  useEffect(() => {
    lastId.current = trs.length ? trs[trs.length - 1].id : 0
    const t = setInterval(() => {
      try {
        const fresh = query.liveTail(db, lastId.current)
        if (fresh.length) {
          lastId.current = fresh[fresh.length - 1].id
          setTrs((prev) => [...prev, ...fresh].slice(-KEEP))
        }
      } catch {}
    }, 1000)
    ;(t as any).unref?.()
    return () => clearInterval(t)
  }, [])

  const visible = trs.slice(-show)

  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow) setCursor((c) => Math.min(visible.length - 1, c + 1))
    if (key.return && visible[cursor]) onOpen(visible[cursor].id)
  })

  if (visible.length === 0) return <Text dimColor>Waiting for requests…</Text>

  return (
    <Box flexDirection="column">
      <TableHeader cols={COLS} widths={widths} />
      {visible.map((r, i) => (
        <TableRow
          key={r.id}
          cols={COLS}
          widths={widths}
          selected={i === Math.min(cursor, visible.length - 1)}
          cells={[
            { text: fmtAgo(r.startedAt), dim: true },
            { text: String(r.status ?? '?'), color: statusColor(r.status) },
            { text: r.method },
            { text: r.entity, color: r.provider ? theme.entityLlm : theme.entityGeneral, bold: !!r.provider },
            { text: r.normalizedEndpoint },
            { text: fmtMs(r.latencyMs), color: latencyColor(r.latencyMs) },
          ]}
        />
      ))}
    </Box>
  )
}
