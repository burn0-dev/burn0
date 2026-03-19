import { AsyncLocalStorage } from 'node:async_hooks'
import type { Burn0Event, Span } from './types'

interface TrackContext {
  feature: string
  metadata?: Record<string, string | number | boolean>
}

const storage = new AsyncLocalStorage<TrackContext>()
let activeSpan: TrackContext | null = null

export function createTracker() {
  async function track(
    feature: string,
    metadata: Record<string, string | number | boolean>,
    fn: () => Promise<void>
  ): Promise<void> {
    await storage.run({ feature, metadata }, fn)
  }

  function startSpan(
    feature: string,
    metadata?: Record<string, string | number | boolean>
  ): Span {
    activeSpan = { feature, metadata }
    return {
      end() { activeSpan = null },
    }
  }

  function enrichEvent(event: Burn0Event): Burn0Event {
    const ctx = storage.getStore() ?? activeSpan
    if (!ctx) return event
    return {
      ...event,
      feature: ctx.feature,
      metadata: ctx.metadata && Object.keys(ctx.metadata).length > 0 ? ctx.metadata : undefined,
    }
  }

  return { track, startSpan, enrichEvent }
}
