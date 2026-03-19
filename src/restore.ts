interface RestoreDeps {
  unpatchFetch: () => void
  unpatchHttp: () => void
  resetGuard: () => void
}

export function createRestorer(deps: RestoreDeps): () => void {
  return () => {
    deps.unpatchFetch()
    deps.unpatchHttp()
    deps.resetGuard()
  }
}
