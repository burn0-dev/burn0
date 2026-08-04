// burn0 TUI theme — single place for the palette.
export const theme = {
  accent: '#ff7a00',   // burn orange — brand, headers, active tab
  cost: 'green',
  model: 'cyan',
  entityLlm: 'magentaBright',
  entityGeneral: 'white',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  dim: 'gray',
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
