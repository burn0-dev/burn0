export function fmtUsd(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1) return `$${n.toFixed(2)}`
  // A real cost that rounds to $0.0000 must not read as free. This is the same
  // rule as null-is-not-zero, one decimal place further down.
  if (n > 0 && n < 0.00005) return '<$0.0001'
  return `$${n.toFixed(4)}`
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtTime(epochMs: number): string {
  const d = new Date(epochMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

/** null is "we never measured it" and renders as a gap — never as 0 B. */
export function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i += 1 }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${BYTE_UNITS[i]}`
}

export function fmtMs(n: number | null): string {
  if (n == null) return '—'
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`
}

export function fmtAgo(epochMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - epochMs) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
