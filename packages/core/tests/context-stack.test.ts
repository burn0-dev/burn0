import { describe, it, expect } from 'vitest'
import { tag, withTags, currentTags } from '../src/context/index.js'
import { captureStackSnippet } from '../src/capture/stack.js'

describe('tag context', () => {
  it('propagates tags through async boundaries', async () => {
    await withTags({ userId: 'u1' }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      expect(currentTags()).toEqual({ userId: 'u1' })
    })
    expect(currentTags()).toBeNull()
  })
  it('tag() merges into active context', async () => {
    await withTags({ a: '1' }, async () => {
      tag({ b: '2' })
      expect(currentTags()).toEqual({ a: '1', b: '2' })
    })
  })
  it('tag() outside context is a safe no-op', () => {
    expect(() => tag({ x: 'y' })).not.toThrow()
  })
})

describe('captureStackSnippet', () => {
  it('returns app frames and filters node internals + burn0 + node_modules', () => {
    const snippet = captureStackSnippet()
    expect(snippet).toBeTruthy()
    expect(snippet!).toContain('context-stack.test.ts')
    expect(snippet!).not.toContain('node:internal')
    expect(snippet!).not.toContain('/src/capture/stack')
  })
})
