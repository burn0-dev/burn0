import { describe, it, expect, vi } from 'vitest'
import { runToday } from '../src/commands/today.js'
import { seedDb } from './helpers/seed.js'

describe('runToday', () => {
  it('prints spend, calls, top models, top entities', () => {
    const { db } = seedDb([
      { costUsd: 0.01 },
      { costUsd: 0.02, model: 'gpt-4o-mini' },
      { entity: 'Stripe', entityClass: 'general', provider: null, model: null, costUsd: null },
    ])
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { lines.push(String(s)); return true })
    runToday({ db })
    spy.mockRestore()
    const out = lines.join('')
    expect(out).toContain('$0.0300')
    expect(out).toContain('gpt-4o')
    expect(out).toContain('Stripe')
    expect(out).toContain('3')
  })
})
