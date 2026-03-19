import { identifyService } from '../services/map'
import type { Burn0Event } from '../types'
import { SCHEMA_VERSION } from '../types'
import { teeReadableStream, collectStream, extractUsageFromSSE } from './stream'

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

    // Extract model from request body (OpenAI, Anthropic, etc.)
    if (init?.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body)
        if (parsed.model) model = parsed.model
      } catch {}
    }

    // Extract model from URL path (Gemini-style: /v1beta/models/gemini-2.0-flash:generateContent)
    if (!model) {
      const modelMatch = url.pathname.match(/\/models\/([^/:]+)/)
      if (modelMatch) model = modelMatch[1]
    }

    const response = await originalFetch!(input, init)
    const duration = Date.now() - startTime

    let tokensIn: number | undefined
    let tokensOut: number | undefined

    // Check for SSE streaming response
    if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
      const [forCaller, forBurn0] = teeReadableStream(response.body)

      collectStream(forBurn0).then((raw) => {
        const usage = extractUsageFromSSE(raw)
        let sseTokensIn = usage?.prompt_tokens ?? usage?.input_tokens
        let sseTokensOut = usage?.completion_tokens ?? usage?.output_tokens
        if (sseTokensIn !== undefined && sseTokensIn < 0) sseTokensIn = undefined
        if (sseTokensOut !== undefined && sseTokensOut < 0) sseTokensOut = undefined
        const sseEvent: Burn0Event = {
          schema_version: SCHEMA_VERSION,
          service,
          endpoint: url.pathname,
          model,
          tokens_in: sseTokensIn,
          tokens_out: sseTokensOut,
          status_code: response.status,
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          estimated: !usage,
        }
        try { onEvent(sseEvent) } catch {}
      }).catch(() => {
        const sseEvent: Burn0Event = {
          schema_version: SCHEMA_VERSION,
          service,
          endpoint: url.pathname,
          model,
          status_code: response.status,
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          estimated: true,
        }
        try { onEvent(sseEvent) } catch {}
      })

      return new Response(forCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        const cloned = response.clone()
        const body = await cloned.json()
        // Standard format (OpenAI, Anthropic, Perplexity)
        if (body.usage) {
          tokensIn = body.usage.prompt_tokens ?? body.usage.input_tokens
          tokensOut = body.usage.completion_tokens ?? body.usage.output_tokens
        }
        // Gemini format
        if (body.usageMetadata) {
          tokensIn = body.usageMetadata.promptTokenCount
          tokensOut = body.usageMetadata.candidatesTokenCount
        }
        if (body.model) model = body.model
      } catch {}
    }

    if (tokensIn !== undefined && tokensIn < 0) tokensIn = undefined
    if (tokensOut !== undefined && tokensOut < 0) tokensOut = undefined

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
