import { existsSync } from 'node:fs'
import { query, type StorageDriver } from '@burn0/core'
import { openReadDb } from '../db.js'
import { label } from '../scope.js'
import { fmtNum, fmtAgo } from '../format.js'

export function runProjects(deps?: { db: StorageDriver }): void {
  const db = deps?.db ?? openReadDb().db
  const all = query.projects(db)
  const w = (line = '') => process.stdout.write(line + '\n')

  if (all.length === 0) {
    w('no projects yet — add `import \'burn0\'` to an app and run it')
    return
  }

  w('burn0 — projects')
  w()
  for (const p of all) {
    // A project whose checkout is gone is shown, not hidden: its history is
    // still real, and silently dropping it looks like data loss (Q1.2).
    const missing = p.rootPath && !existsSync(p.rootPath) ? '  (path missing)' : ''
    w(`  ${label(p, all)}`)
    w(`    ${p.rootPath ?? '(logical project)'}${missing}`)
    const services = p.services.length ? p.services.join(', ') : '—'
    w(`    ${fmtNum(p.calls)} calls · services: ${services} · last seen ${p.lastSeen ? fmtAgo(p.lastSeen) : 'never'}`)
    w()
  }
}
