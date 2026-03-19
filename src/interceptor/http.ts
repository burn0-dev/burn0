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

    const options = typeof args[0] === 'string' ? new URL(args[0]) :
                    args[0] instanceof URL ? args[0] : args[0]
    const hostname = 'hostname' in options ? (options.hostname ?? options.host ?? '') : options.hostname ?? ''
    const cleanHostname = hostname.replace(/:\d+$/, '')
    const service = identifyService(cleanHostname)

    if (!service) return req

    const endpoint = ('pathname' in options ? options.pathname : options.path) ?? '/'

    req.on('response', (res: http.IncomingMessage) => {
      const isJson = res.headers['content-type']?.includes('application/json')
      const chunks: Buffer[] = []
      if (isJson) {
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
      }
      res.on('end', () => {
        const duration = Date.now() - startTime
        let tokensIn: number | undefined
        let tokensOut: number | undefined
        let model: string | undefined

        if (isJson && chunks.length > 0) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString())
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
