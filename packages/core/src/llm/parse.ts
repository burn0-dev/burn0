export interface Usage {
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
}

function nonNeg(n: unknown): number | null {
  return typeof n === 'number' && n >= 0 ? n : null
}

function usageFromObject(o: any): Usage | null {
  if (!o || typeof o !== 'object') return null
  if (o.usage && typeof o.usage === 'object') {
    const u = o.usage
    const tokensIn = nonNeg(u.prompt_tokens) ?? nonNeg(u.input_tokens)
    const tokensOut = nonNeg(u.completion_tokens) ?? nonNeg(u.output_tokens)
    const tokensCached = nonNeg(u.prompt_tokens_details?.cached_tokens) ?? nonNeg(u.cache_read_input_tokens)
    if (tokensIn !== null || tokensOut !== null) return { tokensIn, tokensOut, tokensCached }
  }
  if (o.usageMetadata && typeof o.usageMetadata === 'object') {
    const m = o.usageMetadata
    const tokensIn = nonNeg(m.promptTokenCount)
    const tokensOut = nonNeg(m.candidatesTokenCount)
    if (tokensIn !== null || tokensOut !== null) return { tokensIn, tokensOut, tokensCached: nonNeg(m.cachedContentTokenCount) }
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
      found = tokensIn !== null || found
    }
    if (parsed?.type === 'message_delta' && parsed.usage) {
      tokensOut = nonNeg(parsed.usage.output_tokens) ?? tokensOut
      found = true
    }
    // OpenAI-style: full usage object in a (usually final) chunk
    const u = usageFromObject(parsed)
    if (u) {
      tokensIn = u.tokensIn ?? tokensIn
      tokensOut = u.tokensOut ?? tokensOut
      tokensCached = u.tokensCached ?? tokensCached
      found = true
    }
  }
  return found ? { tokensIn, tokensOut, tokensCached } : null
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
