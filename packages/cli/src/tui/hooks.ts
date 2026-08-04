import { useEffect, useState } from 'react'
import { useStdout } from 'ink'

export function useTermSize(): { columns: number; rows: number } {
  const { stdout } = useStdout()
  // `||` not `??`: some ptys (CI, expect) report 0×0 — treat as unknown
  const read = () => ({ columns: stdout?.columns || 80, rows: stdout?.rows || 24 })
  const [size, setSize] = useState(read)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => setSize(read())
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])
  return size
}

export function usePoll<T>(fn: () => T, intervalMs = 1000, deps: unknown[] = []): T {
  const [value, setValue] = useState<T>(fn)
  useEffect(() => {
    try { setValue(fn()) } catch {}
    const t = setInterval(() => {
      try { setValue(fn()) } catch {}
    }, intervalMs)
    ;(t as any).unref?.()
    return () => clearInterval(t)
  }, deps)
  return value
}
