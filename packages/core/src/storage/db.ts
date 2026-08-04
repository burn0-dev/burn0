import { mkdirSync, renameSync, existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_VERSION, type EnrichedRow } from '../types.js'
import type { ProjectIdentity } from '../project/index.js'
import type { PendingTrace, TraceStep } from '../context/trace.js'
import { openBetterSqlite, type StorageDriver } from './driver.js'
import { DDL } from './schema.js'

export type { StorageDriver, PreparedStmt } from './driver.js'

export function openDatabase(dbPath: string): StorageDriver {
  mkdirSync(dirname(dbPath), { recursive: true })
  let db = openBetterSqlite(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(DDL)
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()
  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION))
  } else if (row.value !== String(SCHEMA_VERSION)) {
    db.close()
    const bak = dbPath + '.bak'
    if (existsSync(bak)) rmSync(bak)
    renameSync(dbPath, bak)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix)
    }
    db = openBetterSqlite(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(DDL)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION))
  }
  return db
}

/** `DO UPDATE`, not `DO NOTHING`: a renamed package.json should update the label.
 *  Existing rows follow automatically because they hold `project_id`, not the name —
 *  with DO NOTHING plus select-by-name, a rename silently forks the history.
 *  `SET name` only: `root_path` is written once, so two repos sharing a name-key
 *  cannot flip-flop it on every process start. */
export function ensureProject(db: StorageDriver, p: ProjectIdentity): number {
  const row = db.prepare(`INSERT INTO projects (key, name, root_path, git_root, first_seen)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET name = excluded.name
              RETURNING id`).get(p.key, p.name, p.rootPath, p.gitRoot, Date.now())
  return row.id as number
}

export function insertRun(db: StorageDriver, r: {
  projectId: number; service: string | null; pid: number | null
  entry: string | null; nodeVersion: string | null; now?: number
}): number {
  const row = db.prepare(`INSERT INTO runs (project_id, service, started_at, pid, entry, node_version)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(r.projectId, r.service, r.now ?? Date.now(), r.pid, r.entry, r.nodeVersion)
  return row.id as number
}

export function endRun(db: StorageDriver, runId: number, now = Date.now()): void {
  db.prepare(`UPDATE runs SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(now, runId)
}

export interface WriteCtx {
  projectId: number
  runId: number | null
  service: string | null
  capturePayloads: boolean
}

/** A trace exists in memory long before it is a row, and its requests may flush
 *  before it closes. Resolved by inserting the trace when it *opens* and updating
 *  on close, with a localId→dbId map that outlives a single flush. Ordering
 *  within the transaction is not optional: traces first, then requests. */
export function createWriter(db: StorageDriver, ctx: WriteCtx) {
  const localToDb = new Map<number, number>()

  const insTrace = db.prepare(`INSERT INTO traces
    (run_id, project_id, parent_id, name, kind, started_at, ended_at, status, incomplete,
     tool_status, attribution)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
  const updTrace = db.prepare(
    `UPDATE traces SET ended_at = ?, status = ?, incomplete = ?, tool_status = ? WHERE id = ?`)
  const insToolIo = db.prepare(`INSERT INTO tool_io (trace_id, args, result) VALUES (?,?,?)
    ON CONFLICT(trace_id) DO UPDATE SET result = excluded.result`)
  const insReq = db.prepare(`INSERT INTO requests
    (project_id, service, run_id, trace_id, seq,
     entity, entity_class, provider, method, url, normalized_endpoint, hostname,
     status, started_at, first_byte_ms, latency_ms, req_bytes, res_bytes,
     model, tokens_in, tokens_out, tokens_cached, cost_usd, estimated, tags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insPay = db.prepare(`INSERT INTO payloads
    (request_id, req_headers, req_body, res_headers, res_body, stack_snippet, req_truncated, res_truncated)
    VALUES (?,?,?,?,?,?,?,?)`)

  const tx = db.transaction((
    traces: { opened: PendingTrace[]; closed: PendingTrace[] }, rows: EnrichedRow[],
  ) => {
    for (const t of traces.opened) {
      if (ctx.runId == null) break        // no run row: traces have nowhere to hang
      const parent = t.parentLocalId != null ? localToDb.get(t.parentLocalId) ?? null : null
      const res: any = insTrace.get(
        ctx.runId, ctx.projectId, parent, t.name, t.kind,
        t.startedAt, t.endedAt, t.status, t.incomplete ? 1 : 0,
        t.toolStatus ?? null, t.attribution ?? null)
      localToDb.set(t.localId, res.id as number)
      if (t.args != null) insToolIo.run(res.id, t.args, null)
    }
    for (const t of traces.closed) {
      const id = localToDb.get(t.localId)
      if (id == null) continue
      updTrace.run(t.endedAt, t.status, t.incomplete ? 1 : 0, t.toolStatus ?? null, id)
      if (t.result != null) insToolIo.run(id, t.args ?? null, t.result)
    }
    for (const r of rows) {
      const trace: TraceStep | null = r.trace ?? null
      // An unresolvable localId means the trace was dropped (live-map overflow).
      // Writing the id anyway would dangle; NULL is the honest answer.
      const traceId = trace ? localToDb.get(trace.localId) ?? null : null
      const res: any = insReq.run(
        ctx.projectId, ctx.service, ctx.runId, traceId, traceId == null ? null : trace!.seq,
        r.entity, r.entityClass, r.provider, r.method, r.url, r.normalizedEndpoint, r.hostname,
        r.status, r.startedAt, r.firstByteMs, r.latencyMs, r.reqBytes, r.resBytes,
        r.model, r.tokensIn, r.tokensOut, r.tokensCached, r.costUsd, r.estimated ? 1 : 0,
        r.tags ? JSON.stringify(r.tags) : null,
      )
      if (ctx.capturePayloads) {
        insPay.run(res.lastInsertRowid, JSON.stringify(r.reqHeaders), r.reqBody,
          JSON.stringify(r.resHeaders), r.resBody, r.stackSnippet, r.reqTruncated ? 1 : 0, r.resTruncated ? 1 : 0)
      }
    }
    // Closed traces will never be referenced again; keeping their ids forever
    // would make this map a slow leak on a long-lived server.
    for (const t of traces.closed) localToDb.delete(t.localId)
  })

  return {
    write(traces: { opened: PendingTrace[]; closed: PendingTrace[] }, rows: EnrichedRow[]): void {
      tx(traces, rows)
    },
  }
}

/** Kept for callers with no trace context (tests, and the export/seed paths). */
export function insertRows(
  db: StorageDriver, projectId: number, rows: EnrichedRow[],
  capturePayloads: boolean, service: string | null = null,
): void {
  createWriter(db, { projectId, runId: null, service, capturePayloads })
    .write({ opened: [], closed: [] }, rows)
}
