import { describe, it, expect } from 'vitest'
import { route } from '../src/router.js'

describe('route', () => {
  it('defaults to tui', () => expect(route([])).toEqual({ kind: 'tui' }))
  it('--cli is tui explicitly', () => expect(route(['--cli'])).toEqual({ kind: 'tui' }))
  it('--web reserved', () => expect(route(['--web'])).toEqual({ kind: 'web' }))
  it('today', () => expect(route(['today'])).toEqual({ kind: 'today' }))
  it('watch', () => expect(route(['watch'])).toEqual({ kind: 'watch' }))
  it('init', () => expect(route(['init'])).toEqual({ kind: 'init' }))
  it('export defaults json to stdout', () => expect(route(['export'])).toEqual({ kind: 'export', format: 'json', out: null }))
  it('export csv with file', () => expect(route(['export', '--csv', '--out', 'x.csv'])).toEqual({ kind: 'export', format: 'csv', out: 'x.csv' }))
  it('unknown arg → help', () => expect(route(['bogus'])).toEqual({ kind: 'help' }))
  it('projects', () => expect(route(['projects'])).toEqual({ kind: 'projects' }))

  // scope flags are global: they must not shift a command into help
  it('scope flags do not change the command', () => {
    expect(route(['--all'])).toEqual({ kind: 'tui' })
    expect(route(['--project', 'alif'])).toEqual({ kind: 'tui' })
    expect(route(['today', '--all'])).toEqual({ kind: 'today' })
    expect(route(['export', '--csv', '--service', 'worker'])).toEqual({ kind: 'export', format: 'csv', out: null })
  })
})
