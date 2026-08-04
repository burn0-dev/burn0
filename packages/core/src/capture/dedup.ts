import { AsyncLocalStorage } from 'node:async_hooks'

const marked = new AsyncLocalStorage<boolean>()

export function runMarked<T>(fn: () => T): T {
  return marked.run(true, fn)
}

export function isMarked(): boolean {
  return marked.getStore() === true
}
