import { identifyService } from '../services/map'
import type { Burn0Event } from '../types'
import { SCHEMA_VERSION } from '../types'

type EventCallback = (event: Burn0Event) => void
let originalFetch: typeof globalThis.fetch | null = null

export function patchFetch(onEvent: EventCallback): void {
  originalFetch = globalThis.fetch

  globalThis.fetch = async function burn0Fetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const startTime = Date.now()
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const hostname = url.hostname
    const service = identifyService(hostname)

    if (!service) {
      return originalFetch!(input, init)
    }

    let model: string | undefined
    if (init?.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body)
        if (parsed.model) model = parsed.model
      } catch {}
    }

    const response = await originalFetch!(input, init)
    const duration = Date.now() - startTime

    let tokensIn: number | undefined
    let tokensOut: number | undefined

    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        const cloned = response.clone()
        const body = await cloned.json()
        if (body.usage) {
          tokensIn = body.usage.prompt_tokens ?? body.usage.input_tokens
          tokensOut = body.usage.completion_tokens ?? body.usage.output_tokens
        }
        if (body.model) model = body.model
      } catch {}
    }

    const event: Burn0Event = {
      schema_version: SCHEMA_VERSION,
      service,
      endpoint: url.pathname,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      status_code: response.status,
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      estimated: false,
    }

    try { onEvent(event) } catch {}
    return response
  }
}

export function unpatchFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch
    originalFetch = null
  }
}
