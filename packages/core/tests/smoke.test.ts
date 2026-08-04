import { describe, it, expect } from 'vitest'
import { SCHEMA_VERSION } from '../src/types.js'

describe('scaffold', () => {
  it('exports schema version', () => {
    expect(SCHEMA_VERSION).toBe(4)
  })
})
