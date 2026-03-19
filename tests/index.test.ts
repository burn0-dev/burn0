import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('burn0 import', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('BURN0_ENABLE_TEST', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('exports track and startSpan', async () => {
    const burn0 = await import('../src/index')
    expect(typeof burn0.track).toBe('function')
    expect(typeof burn0.startSpan).toBe('function')
    expect(typeof burn0.restore).toBe('function')
  })
})
