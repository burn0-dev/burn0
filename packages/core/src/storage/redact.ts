const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'set-cookie', 'proxy-authorization'])
const SK_KEY = /sk-[A-Za-z0-9_-]{10,}/g
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/g

export function redactHeaders(headers: Record<string, string>, extra: string[] = []): Record<string, string> {
  const extraSet = new Set(extra.map((h) => h.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    out[k] = SECRET_HEADERS.has(lk) || extraSet.has(lk) ? '[redacted]' : v
  }
  return out
}

export function redactBody(body: string | null): string | null {
  if (body == null) return body
  return body.replace(SK_KEY, '[redacted]').replace(BEARER, '$1[redacted]')
}
