import type { Burn0Event } from '../types'

export interface BatchBufferOptions {
  sizeThreshold: number
  timeThresholdMs: number
  maxSize: number
  onFlush: (events: Burn0Event[]) => void
}

export class BatchBuffer {
  private events: Burn0Event[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private options: BatchBufferOptions

  constructor(options: BatchBufferOptions) {
    this.options = options
    this.timer = setInterval(() => {
      if (this.events.length > 0) this.flush()
    }, options.timeThresholdMs)
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  add(event: Burn0Event): void {
    this.events.push(event)
    if (this.events.length > this.options.maxSize) {
      this.events = this.events.slice(-this.options.maxSize)
    }
    if (this.events.length >= this.options.sizeThreshold) {
      this.flush()
    }
  }

  flush(): void {
    if (this.events.length === 0) return
    const batch = [...this.events]
    this.events = []
    this.options.onFlush(batch)
  }

  destroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
