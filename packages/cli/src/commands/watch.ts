import { query, type Scope, type StorageDriver } from '@burn0/core'
import { openReadDb } from '../db.js'
import { fmtUsd, fmtMs } from '../format.js'

export function runWatch(
  deps?: { db: StorageDriver; scope?: Scope | null; intervalMs?: number; maxTicks?: number },
): void {
  const opened = deps ? null : openReadDb()
  const db = deps?.db ?? opened!.db
  const scope = deps ? deps.scope ?? null : opened!.scope.scope
  let lastId = query.dbStats(db, scope).maxRequestId
  let ticks = 0
  const maxTicks = deps?.maxTicks ?? Infinity
  process.stdout.write('burn0 watch — live requests (Ctrl-C to exit)\n')
  const timer = setInterval(() => {
    try {
      for (const r of query.liveTail(db, lastId, { scope })) {
        lastId = Math.max(lastId, r.id)
        const cost = r.costUsd != null ? `  ${fmtUsd(r.costUsd)}` : ''
        const model = r.model ? `  ${r.model}` : ''
        process.stdout.write(
          `${new Date(r.startedAt).toLocaleTimeString()}  ${String(r.status ?? 'ERR').padEnd(4)} ${r.method.padEnd(6)} ${r.entity}  ${r.normalizedEndpoint}${model}${cost}  ${fmtMs(r.latencyMs)}\n`)
      }
    } catch {}
    if (++ticks >= maxTicks) clearInterval(timer)
  }, deps?.intervalMs ?? 1000)
  if (maxTicks !== Infinity) timer.unref?.()
}
