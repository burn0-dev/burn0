import { describe, it, expect } from 'vitest'
import { redactHeaders, redactBody, redactQueryString } from '../src/storage/redact.js'

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

describe('redactQueryString', () => {
  it('redacts by value shape, the same patterns bodies use', () => {
    expect(redactQueryString('q=orders&token=sk-proj-Abc123DEF456ghi789JKL'))
      .toBe('q=orders&token=[redacted]')
  })
  it('redacts by parameter name, because a bare key matches no pattern', () => {
    expect(redactQueryString('api_key=9f2c8d1a&$top=20')).toBe('api_key=[redacted]&$top=20')
    expect(redactQueryString('KEY=abc')).toBe('KEY=[redacted]')
  })
  it('leaves ordinary parameters — and their = signs — intact', () => {
    expect(redactQueryString("$filter=CreationDate ge datetime'2026-01-01'&$top=20"))
      .toBe("$filter=CreationDate ge datetime'2026-01-01'&$top=20")
  })
})
