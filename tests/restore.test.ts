import { describe, it, expect, vi } from 'vitest'
import { createRestorer } from '../src/restore'

describe('createRestorer', () => {
  it('calls all three unpatch functions when the restorer is invoked', () => {
    const unpatchFetch = vi.fn()
    const unpatchHttp = vi.fn()
    const resetGuard = vi.fn()

    const restore = createRestorer({ unpatchFetch, unpatchHttp, resetGuard })
    restore()

    expect(unpatchFetch).toHaveBeenCalledOnce()
    expect(unpatchHttp).toHaveBeenCalledOnce()
    expect(resetGuard).toHaveBeenCalledOnce()
  })
})
