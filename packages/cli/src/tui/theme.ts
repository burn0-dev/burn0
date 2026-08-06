// burn0 TUI theme — single place for the palette.
// Hex values are the refined-overview mock palette (2026-08-05); chalk renders
// them as truecolor and degrades to the nearest ANSI color on old terminals.
export const theme = {
  accent: '#ff7a00',      // burn orange — brand, active tab bg
  accentSoft: '#ff9f4c',  // section names, selected window text
  cost: '#69dc98',
  model: 'cyan',
  project: '#b4cce0',
  entityLlm: 'magentaBright',
  entityGeneral: 'white',
  ok: '#69dc98',
  warn: '#ffc75f',
  err: '#ff7272',
  dim: 'gray',
  label: '#c4bbb4',       // metric labels
  textBright: '#f5f1ed',  // metric values
  name: '#f1ebe6',        // row entity names
  glyph: '#d0c5be',       // ◆/◇ row glyphs
  detail: '#8d8580',      // metric detail line, group labels
  muted: '#857d77',       // control labels, help text
  rule: '#49423d',        // section separator lines
  selBg: '#4a3b2a',       // selected row background — warm orange-brown, clearly
                          // heavier than the mock's #2a2725: a 1-line terminal row
                          // has no 42px height or hover cursor to carry the cue

  winBg: '#342a21',       // selected window chip background
  tabFg: '#1d130b',       // active tab text on orange
} as const

export function statusColor(status: number | null): string {
  if (status == null) return theme.err
  if (status >= 500) return theme.err
  if (status >= 400) return theme.warn
  return theme.ok
}

export function latencyColor(ms: number | null): string {
  if (ms == null) return theme.dim
  if (ms >= 2000) return theme.err
  if (ms >= 800) return theme.warn
  return theme.dim
}
