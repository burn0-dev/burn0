import { describe, it, expect } from 'vitest'

describe('connect command', () => {
  it('validates API key format', () => {
    const isValid = (key: string) => key.startsWith('b0_sk_')
    expect(isValid('b0_sk_test123')).toBe(true)
    expect(isValid('invalid_key')).toBe(false)
    expect(isValid('b0_test')).toBe(false)
  })
})
