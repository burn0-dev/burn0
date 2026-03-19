import { describe, it, expect } from 'vitest'
import { checkImportOrder } from '../../src/interceptor/guard'

describe('import order detection', () => {
  it('returns empty array when no known SDKs are pre-loaded', () => {
    const loaded = checkImportOrder()
    expect(loaded).toEqual([])
  })
})
