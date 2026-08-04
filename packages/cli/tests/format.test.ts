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

import { fmtUsd, fmtNum, fmtMs, fmtAgo, fmtTok, fmtTokPair, CACHE_MARK } from '../src/format.js'

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

describe('fmtTok (spec §1.3)', () => {
  const cases: Array<[number | null, string]> = [
    [null, '—'], [0, '0'], [846, '846'], [999, '999'],
    [1000, '1.0k'], [4032, '4.0k'], [46802, '46.8k'], [99949, '99.9k'],
    [99950, '100k'], [100000, '100k'], [999499, '999k'],
    [999500, '1.0M'], [1200000, '1.2M'], [99940000, '99.9M'], [999500000, '1.0B'],
  ]
  for (const [n, want] of cases) it(`${n} → ${want}`, () => expect(fmtTok(n)).toBe(want))
})
describe('fmtTokPair', () => {
  it('marks cache presence with ↺, unspaced', () =>
    expect(fmtTokPair(46802, 46800, 846)).toBe(`46.8k${CACHE_MARK}→846`))
  it('spaced form for the list column', () =>
    expect(fmtTokPair(46802, 46800, 846, true)).toBe(`46.8k${CACHE_MARK} → 846`))
  it('no mark when cache-read is 0 or unknown', () => {
    expect(fmtTokPair(1204, 0, 380)).toBe('1.2k→380')
    expect(fmtTokPair(1204, null, 380)).toBe('1.2k→380')
  })
  it('each side independently null — never renders null as 0', () => {
    expect(fmtTokPair(1200, null, null)).toBe('1.2k→—')
    expect(fmtTokPair(null, null, 846)).toBe('—→846')
    expect(fmtTokPair(null, null, null)).toBe('—')
  })
  it('worst cell fits w12', () =>
    expect(fmtTokPair(99900, 1, 99900).length).toBeLessThanOrEqual(12))
})
