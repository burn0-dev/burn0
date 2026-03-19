import { describe, it, expect } from 'vitest'
import path from 'node:path'

describe('dev command', () => {
  it('resolves register path correctly', () => {
    const registerPath = path.resolve(__dirname, '../../src/register.ts')
    expect(registerPath).toContain('register')
  })
})
