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

/** The value-shaped secret patterns, one definition for every surface that
 *  prints stored text. Exported so the TUI's URL path redacts with exactly the
 *  same rules the capture path used on bodies — two copies of a secret regex
 *  is one copy that will drift. */
export function redactSecretValues(s: string): string {
  return s.replace(SK_KEY, '[redacted]').replace(BEARER, '$1[redacted]')
}

export function redactBody(body: string | null): string | null {
  if (body == null) return body
  return redactSecretValues(body)
}

/** Parameter names whose VALUE is a secret regardless of its shape — a bare
 *  `?api_key=9f2c…` matches no value pattern, and the name is the only signal
 *  there is. */
const SECRET_PARAM = /^(api[-_]?key|key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|passwd|pwd|sig|signature|auth)$/i

/** Query strings are stored verbatim inside `requests.url` — `redactBody` never
 *  ran on a URL, because the endpoint has to stay honest for grouping. The
 *  detail pane is the first surface that ever prints one, so redaction happens
 *  on the way out: same value patterns as bodies, plus the name rule above.
 *  Input is the DECODED query string (redacting before decoding would miss a
 *  percent-encoded key). */
export function redactQueryString(qs: string): string {
  return qs.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    if (eq === -1) return redactSecretValues(pair)
    const name = pair.slice(0, eq)
    if (SECRET_PARAM.test(name)) return `${name}=[redacted]`
    return `${name}=${redactSecretValues(pair.slice(eq + 1))}`
  }).join('&')
}
