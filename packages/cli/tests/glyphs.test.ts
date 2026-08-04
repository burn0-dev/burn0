import { describe, it, expect } from 'vitest'
import { G, visWidth, padCell, truncLeft } from '../src/tui/glyphs.js'

describe('glyphs', () => {
  it('every marker used in numeric-adjacent cells is width 1; tool emoji is 2', () => {
    for (const g of [G.llm, G.api, G.foldClosed, G.foldOpen, G.elide, G.live, '↺']) expect(visWidth(g)).toBe(1)
    expect(visWidth(G.tool)).toBe(2)
  })

  it('padCell pads and truncates by display width without splitting 🔧', () => {
    expect(padCell('abc', 5)).toBe('abc  ')
    expect(padCell('abc', 5, 'right')).toBe('  abc')
    expect(padCell(`${G.tool} sap_execute`, 6)).toBe(`${G.tool} sa${G.elide}`)   // 2+1+2+1 = 6 cells
  })

  it('truncLeft exact cases', () => {
    const p = '/s4hanacloud/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder'
    expect(truncLeft(p, p.length)).toBe(p)                       // fits → whole
    expect(truncLeft(p, 34)).toBe('…API_SALES_ORDER_SRV/A_SalesOrder')  // no slash in first 4 kept → plain
    expect(truncLeft(p, 36)).toBe('…/API_SALES_ORDER_SRV/A_SalesOrder') // slash at kept-index ≤4 → snap
    expect(truncLeft(p, 3)).toBe('…er')
  })

  it('truncLeft with wide chars maintains display width boundary', () => {
    const result = truncLeft('/api/data/漢字テスト/records', 12)
    expect(visWidth(result)).toBeLessThanOrEqual(12)
    expect(result.startsWith('…')).toBe(true)
    expect(result === [...result].join('')).toBe(true) // no replacement chars
  })

  it('truncLeft with non-BMP chars avoids splitting surrogates', () => {
    const result = truncLeft('/files/𝕏𝕐ℤ/item', 8)
    expect(visWidth(result)).toBeLessThanOrEqual(8)
    expect(!result.includes('�')).toBe(true) // no replacement char (U+FFFD)
  })
})
