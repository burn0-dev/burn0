import { describe, it, expect, beforeEach } from 'vitest'
import { canPatch, markPatched, resetGuard } from '../../src/interceptor/guard'

describe('patch guard', () => {
  beforeEach(() => resetGuard())

  it('allows patching on first call', () => {
    expect(canPatch()).toBe(true)
  })

  it('prevents patching after markPatched', () => {
    markPatched()
    expect(canPatch()).toBe(false)
  })

  it('allows patching again after reset', () => {
    markPatched()
    resetGuard()
    expect(canPatch()).toBe(true)
  })
})
