import http from 'node:http'
import https from 'node:https'
import { identifyService } from '../services/map'
import type { Burn0Event } from '../types'
import { SCHEMA_VERSION } from '../types'

type EventCallback = (event: Burn0Event) => void

let originalHttpRequest: typeof http.request | null = null
let originalHttpsRequest: typeof https.request | null = null
let originalHttpGet: typeof http.get | null = null
let originalHttpsGet: typeof https.get | null = null

function wrapRequest(original: typeof http.request, onEvent: EventCallback): typeof http.request {
  return function burn0Request(this: unknown, ...args: Parameters<typeof http.request>): http.ClientRequest {
    const req = original.apply(this, args)
    const startTime = Date.now()

    const firstArg = args[0]
    let hostname = ''
    let endpoint = '/'

    if (typeof firstArg === 'string') {
      try {
        const parsed = new URL(firstArg)
        hostname = parsed.hostname
        endpoint = parsed.pathname
      } catch {}
    } else if (firstArg instanceof URL) {
      hostname = firstArg.hostname
      endpoint = firstArg.pathname
    } else if (firstArg && typeof firstArg === 'object') {
      hostname = (firstArg as http.RequestOptions).hostname ?? (firstArg as http.RequestOptions).host ?? ''
      endpoint = (firstArg as http.RequestOptions).path ?? '/'
    }

    const cleanHostname = hostname.replace(/:\d+$/, '')
    const service = identifyService(cleanHostname)

    if (!service) return req

    req.on('response', (res: http.IncomingMessage) => {
      const isJson = res.headers['content-type']?.includes('application/json')
      const chunks: Buffer[] = []
      const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
      let totalSize = 0
      let tooLarge = false

      if (isJson) {
        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length
          if (totalSize > MAX_RESPONSE_SIZE) {
            tooLarge = true
            return
          }
          chunks.push(chunk)
        })
      }
      res.on('end', () => {
        const duration = Date.now() - startTime
        let tokensIn: number | undefined
        let tokensOut: number | undefined
        let model: string | undefined

        if (isJson && chunks.length > 0 && !tooLarge) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString())
            if (body.usage) {
              tokensIn = body.usage.prompt_tokens ?? body.usage.input_tokens
              tokensOut = body.usage.completion_tokens ?? body.usage.output_tokens
            }
            if (body.model) model = body.model
          } catch {}
        }

        if (tokensIn !== undefined && tokensIn < 0) tokensIn = undefined
        if (tokensOut !== undefined && tokensOut < 0) tokensOut = undefined

        const event: Burn0Event = {
          schema_version: SCHEMA_VERSION,
          service,
          endpoint: endpoint.toString(),
          model,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          status_code: res.statusCode ?? 0,
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          estimated: false,
        }
        try { onEvent(event) } catch {}
      })
    })
    return req
  } as typeof http.request
}

export function patchHttp(onEvent: EventCallback): void {
  originalHttpRequest = http.request
  originalHttpsRequest = https.request
  originalHttpGet = http.get
  originalHttpsGet = https.get
  http.request = wrapRequest(originalHttpRequest, onEvent)
  https.request = wrapRequest(originalHttpsRequest as unknown as typeof http.request, onEvent) as unknown as typeof https.request
  http.get = wrapRequest(originalHttpGet as typeof http.request, onEvent) as typeof http.get
  https.get = wrapRequest(originalHttpsGet as unknown as typeof http.request, onEvent) as unknown as typeof https.get
}

export function unpatchHttp(): void {
  if (originalHttpRequest) { http.request = originalHttpRequest; originalHttpRequest = null }
  if (originalHttpsRequest) { https.request = originalHttpsRequest; originalHttpsRequest = null }
  if (originalHttpGet) { http.get = originalHttpGet; originalHttpGet = null }
  if (originalHttpsGet) { https.get = originalHttpsGet; originalHttpsGet = null }
}
