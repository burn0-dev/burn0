import type { Burn0Event } from '../types'
import { isDebug } from '../config/env'

const SDK_VERSION = '0.1.0'

export async function shipEvents(
  events: Burn0Event[],
  apiKey: string,
  baseUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<boolean> {
  const maxAttempts = 3
  const baseDelayMs = 1000
  const maxDelayMs = 5000

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchFn(`${baseUrl}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-Burn0-SDK-Version': SDK_VERSION,
        },
        body: JSON.stringify({ events, sdk_version: SDK_VERSION }),
      })
      if (response.ok) {
        if (isDebug()) console.log(`[burn0] Shipped ${events.length} events`)
        return true
      }
      if (isDebug()) {
        const body = await response.text().catch(() => '')
        console.warn(`[burn0] Shipping rejected: ${response.status} ${body}`)
      }
    } catch (err) {
      if (isDebug()) {
        console.warn('[burn0] Shipping failed:', (err as Error).message)
      }
    }

    if (attempt < maxAttempts - 1) {
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return false
}
