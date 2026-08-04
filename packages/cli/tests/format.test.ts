import { describe, it, expect } from 'vitest'
import { fmtBytes, fmtUsd } from '../src/format.js'

describe('fmtUsd', () => {
  it('never renders a real cost as $0.0000', () => {
    expect(fmtUsd(0.0000004)).toBe('<$0.0001')
    expect(fmtUsd(0)).toBe('$0.0000')     // a genuine zero stays a zero
    expect(fmtUsd(null)).toBe('—')        // unpriced stays a gap
    expect(fmtUsd(0.0142)).toBe('$0.0142')
    expect(fmtUsd(12.5)).toBe('$12.50')
  })
})

describe('fmtBytes', () => {
  it('scales units and keeps unknown distinct from zero', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(null)).toBe('—')
    expect(fmtBytes(900)).toBe('900 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(fmtBytes(20 * 1024)).toBe('20 KB')
    expect(fmtBytes(2.1 * 1024 * 1024)).toBe('2.1 MB')
  })
})

import { fmtUsd, fmtNum, fmtMs, fmtAgo } from '../src/format.js'

describe('format', () => {
  it('fmtUsd', () => {
    expect(fmtUsd(0.0342)).toBe('$0.0342')
    expect(fmtUsd(12.5)).toBe('$12.50')
    // was '$0.0000' — a real cost must not read as free
    expect(fmtUsd(0.00003)).toBe('<$0.0001')
    expect(fmtUsd(null)).toBe('—')
  })
  it('fmtNum', () => expect(fmtNum(50240)).toBe('50,240'))
  it('fmtMs', () => {
    expect(fmtMs(320)).toBe('320ms')
    expect(fmtMs(1234)).toBe('1.2s')
    expect(fmtMs(null)).toBe('—')
  })
  it('fmtAgo', () => {
    const now = 1_000_000_000
    expect(fmtAgo(now - 120_000, now)).toBe('2m ago')
    expect(fmtAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(fmtAgo(now - 5_000, now)).toBe('5s ago')
  })
})
