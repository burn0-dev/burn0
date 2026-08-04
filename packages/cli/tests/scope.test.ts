import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRows, resolveProject } from '@burn0/core'
import { resolveScope, parseScopeFlags } from '../src/scope.js'
import { baseRow } from './helpers/seed.js'

function repo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'burn0-cli-scope-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }))
  mkdirSync(join(root, '.git'))
  return root
}

function dbWith(roots: { root: string; service?: string; calls: number }[]) {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-cli-db-')), 'burn0.db'))
  for (const r of roots) {
    const id = ensureProject(db, resolveProject(r.root))
    insertRows(db, id, Array.from({ length: r.calls }, () => baseRow()), false, r.service ?? null)
  }
  return db
}

describe('parseScopeFlags', () => {
  it('reads --all, --project and --service', () => {
    expect(parseScopeFlags([])).toEqual({ all: false, project: null, service: null })
    expect(parseScopeFlags(['--all'])).toEqual({ all: true, project: null, service: null })
    expect(parseScopeFlags(['--project', 'checkout'])).toEqual({ all: false, project: 'checkout', service: null })
    expect(parseScopeFlags(['--service', 'worker'])).toEqual({ all: false, project: null, service: 'worker' })
  })

  it('ignores a trailing flag with no value rather than swallowing the next flag', () => {
    expect(parseScopeFlags(['--project'])).toEqual({ all: false, project: null, service: null })
    expect(parseScopeFlags(['--project', '--all'])).toEqual({ all: true, project: null, service: null })
  })
})

describe('resolveScope', () => {
  it('defaults to the project the cwd belongs to', () => {
    const a = repo('server')
    const b = repo('server')
    const db = dbWith([{ root: a, calls: 3 }, { root: b, calls: 5 }])
    const s = resolveScope(db, { all: false, project: null, service: null }, join(a, 'src'))
    expect(s.scope.projectIds).toHaveLength(1)
    expect(s.label).toContain('server')
  })

  it('--all widens to every project', () => {
    const db = dbWith([{ root: repo('a'), calls: 1 }, { root: repo('b'), calls: 1 }])
    const s = resolveScope(db, { all: true, project: null, service: null }, tmpdir())
    expect(s.scope.projectIds).toBeNull()
    expect(s.label).toBe('all projects')
  })

  it('falls back to all when the cwd resolves to no known project', () => {
    // an empty screen is a worse answer than a wider one (D2)
    const db = dbWith([{ root: repo('a'), calls: 1 }])
    const s = resolveScope(db, { all: false, project: null, service: null }, mkdtempSync(join(tmpdir(), 'burn0-elsewhere-')))
    expect(s.scope.projectIds).toBeNull()
    expect(s.fellBack).toBe(true)
  })

  it('--project matches by name', () => {
    const db = dbWith([{ root: repo('alpha'), calls: 1 }, { root: repo('beta'), calls: 1 }])
    const s = resolveScope(db, { all: false, project: 'beta', service: null }, tmpdir())
    expect(s.scope.projectIds).toHaveLength(1)
    expect(s.label).toContain('beta')
  })

  it('--project on an ambiguous name errors and lists the candidates', () => {
    const a = repo('server')
    const b = repo('server')
    const db = dbWith([{ root: a, calls: 1 }, { root: b, calls: 1 }])
    expect(() => resolveScope(db, { all: false, project: 'server', service: null }, tmpdir()))
      .toThrow(/ambiguous/i)
    try {
      resolveScope(db, { all: false, project: 'server', service: null }, tmpdir())
    } catch (e: any) {
      expect(e.message).toContain(a)
      expect(e.message).toContain(b)
    }
  })

  it('--project with no match errors rather than silently showing everything', () => {
    const db = dbWith([{ root: repo('alpha'), calls: 1 }])
    expect(() => resolveScope(db, { all: false, project: 'nope', service: null }, tmpdir()))
      .toThrow(/no project/i)
  })

  it('--service narrows within the project', () => {
    const a = repo('mono')
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-cli-db-')), 'burn0.db'))
    const id = ensureProject(db, resolveProject(a))
    insertRows(db, id, [baseRow()], false, 'api')
    insertRows(db, id, [baseRow()], false, 'worker')
    const s = resolveScope(db, { all: false, project: null, service: 'worker' }, a)
    expect(s.scope.services).toEqual(['worker'])
    expect(s.label).toContain('worker')
  })

  it('disambiguates a duplicated display name with its parent directory', () => {
    const a = repo('server')
    const b = repo('server')
    const db = dbWith([{ root: a, calls: 1 }, { root: b, calls: 1 }])
    const sa = resolveScope(db, { all: false, project: null, service: null }, a)
    const sb = resolveScope(db, { all: false, project: null, service: null }, b)
    expect(sa.label).not.toBe(sb.label)
  })
})
