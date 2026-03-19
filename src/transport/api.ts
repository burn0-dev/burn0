import type { Burn0Event } from '../types'

const SDK_VERSION = '0.1.0'

export async function shipEvents(
  events: Burn0Event[],
  apiKey: string,
  baseUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<boolean> {
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
    return response.ok
  } catch { return false }
}
