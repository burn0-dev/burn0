export interface Usage {
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
  /** Anthropic cache_creation_input_tokens — billed at a premium. null = not reported. */
  tokensCacheWrite: number | null
  /** true when the provider's reported input already contains cached tokens
   *  (OpenAI prompt_tokens, Gemini promptTokenCount); false when it excludes
   *  them (Anthropic input_tokens). Decided by WHICH KEY supplied the number —
   *  gateways classify by payload shape, not hostname (spec §1.2). */
  inputIncludesCache: boolean
}

/** One normalization, applied once in enrich(): tokens_in always means TOTAL
 *  effective input. Idempotent by the flag flip — never applied inside the
 *  per-format parsers, which is how double-adding would happen. */
export function normalizeUsage(u: Usage): Usage {
  if (u.inputIncludesCache || u.tokensIn == null) return u
  return {
    ...u,
    tokensIn: u.tokensIn + (u.tokensCached ?? 0) + (u.tokensCacheWrite ?? 0),
    inputIncludesCache: true,
  }
}

function nonNeg(n: unknown): number | null {
  return typeof n === 'number' && n >= 0 ? n : null
}

function usageFromObject(o: any): Usage | null {
  if (!o || typeof o !== 'object') return null
  if (o.usage && typeof o.usage === 'object') {
    const u = o.usage
    const oaIn = nonNeg(u.prompt_tokens)
    const anIn = nonNeg(u.input_tokens)
    const tokensIn = oaIn ?? anIn
    const tokensOut = nonNeg(u.completion_tokens) ?? nonNeg(u.output_tokens)
    const tokensCached = nonNeg(u.prompt_tokens_details?.cached_tokens) ?? nonNeg(u.cache_read_input_tokens)
    const tokensCacheWrite = nonNeg(u.cache_creation_input_tokens)
    if (tokensIn !== null || tokensOut !== null) {
      return { tokensIn, tokensOut, tokensCached, tokensCacheWrite, inputIncludesCache: oaIn != null }
    }
  }
  if (o.usageMetadata && typeof o.usageMetadata === 'object') {
    const m = o.usageMetadata
    const tokensIn = nonNeg(m.promptTokenCount)
    const tokensOut = nonNeg(m.candidatesTokenCount)
    if (tokensIn !== null || tokensOut !== null) {
      return { tokensIn, tokensOut, tokensCached: nonNeg(m.cachedContentTokenCount), tokensCacheWrite: null, inputIncludesCache: true }
    }
  }
  return null
}

export function parseUsage(resBody: string | null): Usage | null {
  if (!resBody) return null
  try {
    return usageFromObject(JSON.parse(resBody))
  } catch {
    return null
  }
}

export function parseSSEUsage(raw: string): Usage | null {
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let tokensCached: number | null = null
  let tokensCacheWrite: number | null = null
  let inputIncludesCache = true
  let found = false
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    let parsed: any
    try { parsed = JSON.parse(line.slice(6)) } catch { continue }
    // Anthropic: usage split across message_start (input) and message_delta (output)
    const msgUsage = parsed?.message?.usage
    if (msgUsage) {
      tokensIn = nonNeg(msgUsage.input_tokens) ?? tokensIn
      tokensCached = nonNeg(msgUsage.cache_read_input_tokens) ?? tokensCached
      tokensCacheWrite = nonNeg(msgUsage.cache_creation_input_tokens) ?? tokensCacheWrite
      if (nonNeg(msgUsage.input_tokens) != null) inputIncludesCache = false
      found = tokensIn !== null || found
    }
    if (parsed?.type === 'message_delta' && parsed.usage) {
      tokensOut = nonNeg(parsed.usage.output_tokens) ?? tokensOut
      found = true
    }
    // OpenAI-style: full usage object in a (usually final) chunk
    const u = usageFromObject(parsed)
    if (u) {
      if (u.tokensIn != null) inputIncludesCache = u.inputIncludesCache
      tokensIn = u.tokensIn ?? tokensIn
      tokensOut = u.tokensOut ?? tokensOut
      tokensCached = u.tokensCached ?? tokensCached
      tokensCacheWrite = u.tokensCacheWrite ?? tokensCacheWrite
      found = true
    }
  }
  return found ? { tokensIn, tokensOut, tokensCached, tokensCacheWrite, inputIncludesCache } : null
}

export function extractModel(reqBody: string | null, urlPath: string, resBody: string | null): string | null {
  if (reqBody) {
    try {
      const m = JSON.parse(reqBody)?.model
      if (typeof m === 'string') return m
    } catch {}
  }
  const pathMatch = urlPath.match(/\/models\/([^/:?]+)/)
  if (pathMatch) return pathMatch[1]
  if (resBody) {
    try {
      const m = JSON.parse(resBody)?.model
      if (typeof m === 'string') return m
    } catch {}
  }
  return null
}
