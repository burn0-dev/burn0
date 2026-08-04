import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

// Column-spec table primitives. Fixed-width cells are padded, `grow` columns
// share the remaining terminal width, so tables always span the full screen
// and the selection highlight covers the whole row.

export interface ColDef {
  label: string
  width?: number          // fixed char width (min width for grow columns)
  grow?: boolean
  align?: 'left' | 'right'
}

const GAP = 2

export function colWidths(total: number, cols: ColDef[]): number[] {
  const fixed = cols.reduce((s, c) => s + (c.grow ? 0 : c.width ?? 8), 0)
  const growers = cols.filter((c) => c.grow)
  const avail = Math.max(0, total - fixed - GAP * (cols.length - 1))
  const share = growers.length ? Math.floor(avail / growers.length) : 0
  return cols.map((c) => (c.grow ? Math.max(c.width ?? 8, share) : c.width ?? 8))
}

function fit(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  if (s.length > w) return w > 1 ? s.slice(0, w - 1) + '…' : s.slice(0, w)
  return align === 'right' ? s.padStart(w) : s.padEnd(w)
}

export interface Cell {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

export function TableHeader({ cols, widths }: { cols: ColDef[]; widths: number[] }) {
  return (
    <Text dimColor wrap="truncate">
      {cols.map((c, i) => fit(c.label.toUpperCase(), widths[i], c.align)).join(' '.repeat(GAP))}
    </Text>
  )
}

export function TableRow({ cells, cols, widths, selected = false }: {
  cells: Cell[]
  cols: ColDef[]
  widths: number[]
  selected?: boolean
}) {
  return (
    <Text inverse={selected} wrap="truncate">
      {cells.map((cell, i) => (
        <React.Fragment key={i}>
          <Text color={cell.color} bold={cell.bold} dimColor={cell.dim}>
            {fit(cell.text, widths[i] ?? 8, cols[i]?.align)}
          </Text>
          {i < cells.length - 1 && <Text>{' '.repeat(GAP)}</Text>}
        </React.Fragment>
      ))}
    </Text>
  )
}

export function Card({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} flexGrow={1} flexBasis={0}>
      <Text dimColor wrap="truncate">{label}</Text>
      <Text bold color={color} wrap="truncate">{value}</Text>
    </Box>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold color={theme.accent}>{title}</Text>
      {children}
    </Box>
  )
}

export function Rule({ columns }: { columns: number }) {
  return <Text dimColor>{'─'.repeat(Math.max(0, columns))}</Text>
}
