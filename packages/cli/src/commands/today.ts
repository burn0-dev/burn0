import { query, type Scope, type StorageDriver } from '@burn0/core'
import { openReadDb } from '../db.js'
import { fmtUsd, fmtNum } from '../format.js'

export function runToday(deps?: { db: StorageDriver; scope?: Scope | null; label?: string }): void {
  const opened = deps ? null : openReadDb()
  const db = deps?.db ?? opened!.db
  const scope = deps ? deps.scope ?? null : opened!.scope.scope
  const scopeLabel = deps ? deps.label : opened!.scope.label
  const s = query.todaySummary(db, Date.now(), scope)
  const w = (line = '') => process.stdout.write(line + '\n')
  w(`burn0 — today${scopeLabel ? ` — ${scopeLabel}` : ''}`)
  w()
  w(`  LLM spend:   ${fmtUsd(s.spendToday)}`)
  w(`  Total calls: ${fmtNum(s.callsToday)}`)
  w()
  if (s.topModels.length) {
    w(`  Top models:`)
    for (const m of s.topModels) w(`    ${m.model}  ${fmtUsd(m.costUsd)}  (${fmtNum(m.calls)} calls)`)
    w()
  }
  if (s.topEntities.length) {
    w(`  Top entities:`)
    for (const e of s.topEntities) w(`    ${e.entity}  ${fmtNum(e.calls)} calls  ${e.costUsd ? fmtUsd(e.costUsd) : ''}`.trimEnd())
  }
}
