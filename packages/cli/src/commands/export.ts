import { writeFileSync } from 'node:fs'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { openReadDb } from '../db.js'

const COLS = query.EXPORT_COLS

export function runExport(
  format: 'json' | 'csv', out: string | null,
  deps?: { db: StorageDriver; scope?: Scope | null },
): void {
  const resolved = deps ? { db: deps.db, scope: deps.scope ?? null } : pick(openReadDb())
  const rows = query.exportRows(resolved.db, resolved.scope)
  const text = format === 'json' ? JSON.stringify(rows, null, 2) : toCsv(rows)
  if (out) {
    writeFileSync(out, text)
    process.stdout.write(`exported ${rows.length} rows to ${out}\n`)
  } else {
    process.stdout.write(text)
  }
}

function pick(r: ReturnType<typeof openReadDb>) {
  return { db: r.db, scope: r.scope.scope }
}

function toCsv(rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [COLS.join(',')]
  for (const r of rows) lines.push(COLS.map((c) => esc(r[c])).join(','))
  return lines.join('\n') + '\n'
}
