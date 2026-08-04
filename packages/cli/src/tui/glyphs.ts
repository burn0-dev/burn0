import stringWidth from 'string-width'

/** Every glyph the trace view draws, in one place, beside the composition
 *  rules that keep them from shearing columns. All width-1 except tool (2) —
 *  measured against Ink's own string-width (spec §2.1). */
export const G = {
  llm: '◆', api: '◇', tool: '🔧',
  foldClosed: '▸', foldOpen: '▾', elide: '…', live: '●', warnWord: '⚠',
  guideV: '│ ', guideT: '├ ', guideL: '└ ', guideGap: '  ',
} as const

export function visWidth(s: string): number { return stringWidth(s) }

/** Pad or right-truncate to an exact DISPLAY width. Iterates code points so a
 *  surrogate pair (🔧) is dropped whole, never split into replacement chars. */
export function padCell(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  const width = stringWidth(s)
  if (width <= w) {
    const pad = ' '.repeat(w - width)
    return align === 'right' ? pad + s : s + pad
  }
  let out = ''
  let used = 0
  for (const cp of s) {                    // code-point iteration
    const cw = stringWidth(cp)
    if (used + cw > w - 1) break
    out += cp
    used += cw
  }
  return out + G.elide + ' '.repeat(Math.max(0, w - used - 1))
}

/** Left-truncation for endpoint tails: the tail is where the signal lives.
 *  `…` is always exactly one char, always leftmost. Snap forward to a `/`
 *  only when one occurs within the first 4 kept chars — a greedy break-at-/
 *  would collapse `…SRV/$metadata` to `…/$metadata` and destroy the signal. */
export function truncLeft(path: string, w: number): string {
  if (stringWidth(path) <= w) return path
  let tail = path.slice(-(w - 1))
  const slash = tail.indexOf('/')
  if (slash >= 0 && slash <= 4) tail = tail.slice(slash || 1)
  return G.elide + tail
}
