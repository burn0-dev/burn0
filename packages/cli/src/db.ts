import { loadConfig, openDatabase, type StorageDriver } from '@burn0/core'
import { parseScopeFlags, resolveScope, type ResolvedScope } from './scope.js'

/** Read-only. Retention runs on capture init now (see `core/src/init.ts`) — a
 *  read command that deletes rows is surprising, and it made `burn0 export`
 *  destructive. */
export function openReadDb(argv: string[] = process.argv.slice(2)): {
  db: StorageDriver
  dbPath: string
  scope: ResolvedScope
} {
  const cfg = loadConfig(process.cwd(), process.env)
  const db = openDatabase(cfg.dbPath)
  const scope = resolveScope(db, parseScopeFlags(argv))
  return { db, dbPath: cfg.dbPath, scope }
}
