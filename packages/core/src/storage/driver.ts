import Database from 'better-sqlite3'

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

// Thin adapter: better-sqlite3 today; bun:sqlite / node:sqlite later.
export function openBetterSqlite(path: string): StorageDriver {
  const db = new Database(path)
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql) as unknown as PreparedStmt,
    transaction: (fn) => db.transaction(fn) as any,
    pragma: (s) => db.pragma(s),
    close: () => db.close(),
  }
}
