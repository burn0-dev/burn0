import type { EnrichedRow } from '../types.js'

export class WriteQueue {
  private pending: EnrichedRow[] = []
  private timer: NodeJS.Timeout | null = null
  dropped = 0

  constructor(private opts: {
    flush: (rows: EnrichedRow[]) => void
    maxPending?: number
    intervalMs?: number
    maxBatch?: number
  }) {}

  push(row: EnrichedRow): void {
    try {
      this.pending.push(row)
      const maxPending = this.opts.maxPending ?? 5000
      while (this.pending.length > maxPending) {
        this.pending.shift()
        this.dropped++
      }
      if (this.pending.length >= (this.opts.maxBatch ?? 100)) {
        this.flushNow()
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flushNow(), this.opts.intervalMs ?? 250)
        this.timer.unref?.()
      }
    } catch {
      this.dropped++
    }
  }

  flushNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    try {
      this.opts.flush(batch)
    } catch {
      this.dropped += batch.length
    }
  }

  stop(): void {
    this.flushNow()
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}
