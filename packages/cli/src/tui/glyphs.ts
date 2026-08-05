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
 *  would collapse `…SRV/$metadata` to `…/$metadata` and destroy the signal.
 *  A slash already at index 0 needs no snap and keeps its place: `…/sap/API_…`
 *  says the segment is whole, `…sap/API_…` says its head was cut off (§2.2).
 *  Accumulates tail by display width from the END, iterating code points to
 *  avoid splitting surrogate pairs on non-BMP characters. */
export function truncLeft(path: string, w: number): string {
  if (stringWidth(path) <= w) return path

  // Accumulate tail by display width from the end, iterating code points
  const codePoints = [...path]
  let tail = ''
  let usedWidth = 0

  for (let i = codePoints.length - 1; i >= 0; i--) {
    const cp = codePoints[i]
    const cpWidth = stringWidth(cp)
    if (usedWidth + cpWidth > w - 1) break
    tail = cp + tail
    usedWidth += cpWidth
  }

  // Apply slash-snap logic (slash index computed in code points). Index 0 is
  // already on the boundary — snapping is a no-op there, not a reason to drop
  // the slash.
  const tailCodePoints = [...tail]
  const slashIndex = tailCodePoints.indexOf('/')
  if (slashIndex > 0 && slashIndex <= 4) {
    tail = tailCodePoints.slice(slashIndex).join('')
  }

  return G.elide + tail
}
