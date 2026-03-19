import type { Burn0Event, RuntimeMode } from '../types'

interface DispatcherDeps {
  logEvent?: (event: Burn0Event) => void
  writeLedger?: (event: Burn0Event) => void
  addToBatch?: (event: Burn0Event) => void
  accumulate?: (event: Burn0Event) => void
}

export function createDispatcher(mode: RuntimeMode, deps: DispatcherDeps): (event: Burn0Event) => void {
  return (event: Burn0Event) => {
    switch (mode) {
      case 'dev-local':
        deps.logEvent?.(event); deps.writeLedger?.(event); break
      case 'dev-cloud':
        deps.logEvent?.(event); deps.addToBatch?.(event); break
      case 'prod-cloud':
        deps.addToBatch?.(event); break
      case 'prod-local':
        deps.accumulate?.(event); break
      case 'test-enabled':
        deps.logEvent?.(event); deps.writeLedger?.(event); deps.addToBatch?.(event); break
      case 'test-disabled':
        break
    }
  }
}
