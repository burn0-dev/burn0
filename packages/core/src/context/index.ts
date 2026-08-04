import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage<Record<string, string>>()

export function withTags<T>(tags: Record<string, string>, fn: () => T): T {
  return als.run({ ...tags }, fn)
}

export function tag(tags: Record<string, string>): void {
  try {
    const store = als.getStore()
    if (store) Object.assign(store, tags)
  } catch {}
}

export function currentTags(): Record<string, string> | null {
  const store = als.getStore()
  return store && Object.keys(store).length > 0 ? { ...store } : null
}
