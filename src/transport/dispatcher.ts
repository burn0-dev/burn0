import type { Burn0Event, RuntimeMode } from '../types'

interface DispatcherDeps {
  logEvent?: (event: Burn0Event) => void
  writeLedger?: (event: Burn0Event) => void
  addToBatch?: (event: Burn0Event) => void
}

export function createDispatcher(mode: RuntimeMode, deps: DispatcherDeps): (event: Burn0Event) => void {
  return (event: Burn0Event) => {
    if (mode === 'test-disabled') return
    deps.logEvent?.(event)
    deps.writeLedger?.(event)
    deps.addToBatch?.(event)
  }
}
