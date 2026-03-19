import { describe, it, expect, beforeEach } from 'vitest'
import { identifyService, mergeServiceMap, resetServiceMap } from '../../src/services/map'

describe('identifyService', () => {
  beforeEach(() => resetServiceMap())

  it('identifies known services by hostname', () => {
    expect(identifyService('api.openai.com')).toBe('openai')
    expect(identifyService('api.anthropic.com')).toBe('anthropic')
    expect(identifyService('api.stripe.com')).toBe('stripe')
  })

  it('returns unknown:hostname for unrecognized external hosts', () => {
    expect(identifyService('api.someservice.io')).toBe('unknown:api.someservice.io')
  })

  it('returns null for localhost and internal hosts', () => {
    expect(identifyService('localhost')).toBeNull()
    expect(identifyService('127.0.0.1')).toBeNull()
    expect(identifyService('0.0.0.0')).toBeNull()
    expect(identifyService('[::1]')).toBeNull()
  })
})

describe('mergeServiceMap', () => {
  beforeEach(() => resetServiceMap())

  it('merges remote map entries into built-in map', () => {
    const remote = { 'api.newservice.com': 'newservice' }
    mergeServiceMap(remote)
    expect(identifyService('api.newservice.com')).toBe('newservice')
  })

  it('remote entries override built-in entries', () => {
    const remote = { 'api.openai.com': 'openai-custom' }
    mergeServiceMap(remote)
    expect(identifyService('api.openai.com')).toBe('openai-custom')
  })
})
