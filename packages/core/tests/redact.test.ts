import { describe, it, expect } from 'vitest'
import { redactHeaders, redactBody } from '../src/storage/redact.js'

describe('redactHeaders', () => {
  it('redacts secret headers case-insensitively', () => {
    const out = redactHeaders({ Authorization: 'Bearer sk-abc', 'x-api-key': 'k', Cookie: 'a=1', 'Set-Cookie': 'b=2', 'content-type': 'application/json' })
    expect(out).toEqual({
      Authorization: '[redacted]', 'x-api-key': '[redacted]', Cookie: '[redacted]', 'Set-Cookie': '[redacted]',
      'content-type': 'application/json',
    })
  })
  it('redacts extra configured headers', () => {
    expect(redactHeaders({ 'x-internal-token': 'v' }, ['x-internal-token'])).toEqual({ 'x-internal-token': '[redacted]' })
  })
})

describe('redactBody', () => {
  it('redacts sk- keys and bearer tokens inside bodies', () => {
    expect(redactBody('{"key":"sk-proj-Abc123DEF456ghi789JKL"}')).toBe('{"key":"[redacted]"}')
    expect(redactBody('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y')).toBe('Authorization: Bearer [redacted]')
  })
  it('passes null and clean bodies through', () => {
    expect(redactBody(null)).toBeNull()
    expect(redactBody('{"model":"gpt-4o"}')).toBe('{"model":"gpt-4o"}')
  })
})
