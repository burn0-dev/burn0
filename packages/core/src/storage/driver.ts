import { createRequire } from 'node:module'
import { detectRuntime } from '../runtime.js'

export interface PreparedStmt {
  run(...args: unknown[]): unknown
  get(...args: unknown[]): any
  all(...args: unknown[]): any[]
}

export interface StorageDriver {
  exec(sql: string): void
  prepare(sql: string): PreparedStmt
  transaction<A extends any[]>(fn: (...a: A) => void): (...a: A) => void
  pragma(s: string): unknown
  close(): void
}

const require_ = createRequire(import.meta.url)

/** Bun refuses to load better-sqlite3 outright ("not yet supported",
 *  oven-sh/bun#4290) — the refusal happens at require time, which is why the
 *  require must be lazy: a top-level import would take the whole module graph
 *  down with it before init's try/catch exists. */
export function openBetterSqlite(path: string): StorageDriver {
  const Database = require_('better-sqlite3')
  const db = new Database(path)
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql) as unknown as PreparedStmt,
    transaction: (fn) => db.transaction(fn) as any,
    pragma: (s) => db.pragma(s),
    close: () => db.close(),
  }
}

/** bun:sqlite over the same interface. Verified against better-sqlite3 for the
 *  operations the writer relies on: positional `?` binding, `RETURNING` through
 *  `.get()`, `.run()` reporting `lastInsertRowid`/`changes`, multi-statement
 *  `exec`, and `transaction()` returning a callable. Both bindings speak WAL,
 *  so the Node CLI reads a Bun-written file unchanged. */
export function openBunSqlite(path: string): StorageDriver {
  const { Database } = require_('bun:sqlite')
  const db = new Database(path)
  return {
    exec: (sql) => db.exec(sql),
    // db.query() caches statements per database — prepare-per-call stays cheap.
    prepare: (sql) => db.query(sql) as unknown as PreparedStmt,
    transaction: (fn: any) => db.transaction(fn) as any,
    pragma: (s) => db.query(`PRAGMA ${s}`).get(),
    close: () => db.close(),
  }
}

export function openDriver(path: string): StorageDriver {
  return detectRuntime() === 'bun' ? openBunSqlite(path) : openBetterSqlite(path)
}
