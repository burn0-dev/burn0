import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectMode, getApiKey } from '../../src/config/env'

describe('getApiKey', () => {
  beforeEach(() => { vi.unstubAllEnvs() })

  it('returns the API key from BURN0_API_KEY', () => {
    vi.stubEnv('BURN0_API_KEY', 'b0_sk_test123')
    expect(getApiKey()).toBe('b0_sk_test123')
  })

  it('returns undefined when no key is set', () => {
    vi.stubEnv('BURN0_API_KEY', '')
    expect(getApiKey()).toBeUndefined()
  })
})

describe('detectMode', () => {
  beforeEach(() => { vi.unstubAllEnvs() })

  it('returns test-disabled when NODE_ENV is test and no opt-in', () => {
    vi.stubEnv('NODE_ENV', 'test')
    expect(detectMode({ isTTY: true, apiKey: undefined })).toBe('test-disabled')
  })

  it('returns test-enabled when NODE_ENV is test and opt-in set', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('BURN0_ENABLE_TEST', '1')
    expect(detectMode({ isTTY: true, apiKey: 'b0_sk_x' })).toBe('test-enabled')
  })

  it('returns dev-cloud when API key present and TTY', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(detectMode({ isTTY: true, apiKey: 'b0_sk_x' })).toBe('dev-cloud')
  })

  it('returns dev-local when no API key and TTY', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(detectMode({ isTTY: true, apiKey: undefined })).toBe('dev-local')
  })

  it('returns prod-cloud when API key present and no TTY', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(detectMode({ isTTY: false, apiKey: 'b0_sk_x' })).toBe('prod-cloud')
  })

  it('returns prod-local when no API key and no TTY', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(detectMode({ isTTY: false, apiKey: undefined })).toBe('prod-local')
  })
})
