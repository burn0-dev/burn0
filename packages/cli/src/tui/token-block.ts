// The fresh/cached/written token breakdown (spec §1.3) — one definition,
// shared by every screen that renders a token block (TraceDetail's card,
// Debug's payload screen). Pure data: callers own layout, clipping and color.
import { fmtNum, CACHE_MARK } from '../format.js'

export interface TokenFacts {
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
  tokensCacheWrite: number | null
}

export interface TokenBreakdown {
  /** "tokens  46,802 → 846" (or "tokens  —" when neither side is known). */
  head: string
  /** null when it can't be computed (no cached/written info to subtract) —
   *  never rendered as 0 in that case, which would claim knowledge nobody
   *  reported. */
  fresh: string | null
  /** null when tokensCached itself is null — a null line is omitted (nobody
   *  reported it); a zero line IS shown (somebody reported zero). */
  cached: string | null
  written: string | null
}

/** ```
 *  tokens  46,802 → 846
 *    fresh   2
 *    cached  46,800 ↺ (99%)
 *    written 1,024
 *  ``` */
export function tokenBreakdown(n: TokenFacts): TokenBreakdown {
  const head = n.tokensIn == null && n.tokensOut == null
    ? 'tokens  —'
    : `tokens  ${n.tokensIn == null ? '—' : fmtNum(n.tokensIn)} → ${n.tokensOut == null ? '—' : fmtNum(n.tokensOut)}`

  let fresh: string | null = null
  if (n.tokensIn != null && (n.tokensCached != null || n.tokensCacheWrite != null)) {
    fresh = fmtNum(Math.max(0, n.tokensIn - (n.tokensCached ?? 0) - (n.tokensCacheWrite ?? 0)))
  }

  let cached: string | null = null
  if (n.tokensCached != null) {
    const mark = n.tokensCached > 0 ? ` ${CACHE_MARK}` : ''
    // Floored, not rounded: 99.6% cached must not read as "100% cached".
    const pct = n.tokensIn != null && n.tokensIn > 0
      ? ` (${Math.floor((n.tokensCached / n.tokensIn) * 100)}%)` : ''
    cached = `${fmtNum(n.tokensCached)}${mark}${pct}`
  }

  const written = n.tokensCacheWrite != null ? fmtNum(n.tokensCacheWrite) : null

  return { head, fresh, cached, written }
}
