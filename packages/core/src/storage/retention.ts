import type { StorageDriver } from './driver.js'

const DAY = 86_400_000
const VACUUM_INTERVAL = 7 * DAY

/** Scoped to one project when `projectId` is given. Without it, project A's
 *  retention settings delete project B's rows — which is what happened while
 *  this ran from the CLI's read path using whatever config the reader's cwd
 *  resolved to. It now runs on capture init: the writer knows its own project
 *  and its own config, and opening a dashboard stops deleting data. */
export function pruneRetention(
  db: StorageDriver, days: { payloads: number; metadata: number }, now = Date.now(), projectId?: number,
): void {
  const scope = projectId != null ? ' AND project_id = ?' : ''
  const extra = projectId != null ? [projectId] : []
  const metaCut = now - days.metadata * DAY
  db.prepare(`DELETE FROM payloads WHERE request_id IN (SELECT id FROM requests WHERE started_at < ?${scope})`)
    .run(now - days.payloads * DAY, ...extra)

  // Count what is about to be deleted, onto the trace that owned it. This is
  // the only honest source for "N calls expired": the sweep is the one actor
  // that ever knows N (spec §4). Runs before the trace itself might be deleted
  // below — the UPDATE and the later trace DELETE share the same cutoff, so a
  // trace that ages out this pass still gets its count recorded first.
  db.prepare(`UPDATE traces SET expired_calls = expired_calls + (
      SELECT COUNT(*) FROM requests r
      WHERE r.trace_id = traces.id AND r.started_at < ?${scope.replace('project_id', 'r.project_id')})
    WHERE id IN (SELECT DISTINCT trace_id FROM requests
      WHERE trace_id IS NOT NULL AND started_at < ?${scope})`)
    .run(metaCut, ...extra, metaCut, ...extra)

  db.prepare(`DELETE FROM requests WHERE started_at < ?${scope}`).run(metaCut, ...extra)

  // Traces and runs age out on the same clock as the requests they held. Deleted
  // explicitly rather than through ON DELETE CASCADE: better-sqlite3 leaves
  // `PRAGMA foreign_keys` off by default, so the cascade would silently not fire.
  db.prepare(`DELETE FROM tool_io WHERE trace_id IN (
      SELECT id FROM traces WHERE started_at < ?${scope})`).run(metaCut, ...extra)
  // children before parents, so no row is orphaned mid-delete
  db.prepare(`DELETE FROM traces WHERE started_at < ?${scope} AND parent_id IS NOT NULL`).run(metaCut, ...extra)
  db.prepare(`DELETE FROM traces WHERE started_at < ?${scope}`).run(metaCut, ...extra)
  db.prepare(`DELETE FROM runs WHERE started_at < ?${scope}`).run(metaCut, ...extra)

  // Bulky tool arguments and results share the payload lifetime, not the trace's:
  // a three-week-old trace still shows which tools ran and whether they failed.
  db.prepare(`DELETE FROM tool_io WHERE trace_id IN (
      SELECT id FROM traces WHERE started_at < ?${scope})`).run(now - days.payloads * DAY, ...extra)
}

export function maybeVacuum(db: StorageDriver, now = Date.now()): void {
  const row = db.prepare(`SELECT value FROM meta WHERE key='last_vacuum'`).get()
  const last = row ? Number(row.value) : 0
  if (now - last < VACUUM_INTERVAL) return
  db.exec('VACUUM')
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_vacuum', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now))
}
