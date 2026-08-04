export interface CaptureEvent {
  startedAt: number            // epoch ms
  method: string
  url: string
  hostname: string
  status: number | null
  firstByteMs: number | null
  latencyMs: number | null
  // null = not observed on this capture path. Never 0 for "we didn't look" —
  // a displayed 0 reads as "nothing transferred", which is a different claim.
  reqBytes: number | null
  resBytes: number | null
  reqHeaders: Record<string, string>
  resHeaders: Record<string, string>
  reqBody: string | null
  resBody: string | null
  stackSnippet: string | null
  tags: Record<string, string> | null
  estimated: boolean           // usage inferred/partial (aborted stream etc.)
  /** The trace this call belongs to, read when the call *starts* — by response
   *  time the async context has moved on. null = outside any trace. */
  trace: { localId: number; seq: number } | null
}

export interface EnrichedRow extends CaptureEvent {
  entity: string
  entityClass: 'llm' | 'general'
  provider: string | null
  normalizedEndpoint: string
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
  costUsd: number | null
  reqTruncated: boolean
  resTruncated: boolean
}

export const SCHEMA_VERSION = 3
