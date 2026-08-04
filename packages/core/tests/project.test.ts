import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProject, resolveService } from '../src/project/index.js'

function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'burn0-proj-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app' }))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  return root
}

/** macOS puts tmpdir behind /private, so compare against the resolved path. */
const real = (p: string) => realpathSync.native(p)

describe('resolveProject', () => {
  it('uses explicit override for the name', () => {
    const root = tempTree()
    expect(resolveProject(join(root, 'src/deep'), 'alif-backend').name).toBe('alif-backend')
  })

  it('the git root is the project, not the nearest package.json', () => {
    const root = tempTree()
    mkdirSync(join(root, 'apps', 'api'), { recursive: true })
    writeFileSync(join(root, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api' }))
    const p = resolveProject(join(root, 'apps', 'api'))
    expect(p.name).toBe('my-app')          // the repo, not the package
    expect(p.rootPath).toBe(real(root))
    expect(p.gitRoot).toBe(real(root))
  })

  it('falls back to the nearest package.json when there is no git root', () => {
    const bare = mkdtempSync(join(tmpdir(), 'burn0-nogit-'))
    mkdirSync(join(bare, 'sub'), { recursive: true })
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'loose' }))
    const p = resolveProject(join(bare, 'sub'))
    expect(p.name).toBe('loose')
    expect(p.gitRoot).toBeNull()
  })

  it('falls back to the directory basename when there is no package.json either', () => {
    const bare = mkdtempSync(join(tmpdir(), 'burn0-bare-'))
    expect(resolveProject(bare).name).toBe(bare.split('/').pop())
  })
})

describe('project identity key', () => {
  it('is keyed on path by default, so two repos named the same stay separate', () => {
    const a = tempTree()
    const b = tempTree()
    const pa = resolveProject(a)
    const pb = resolveProject(b)
    expect(pa.name).toBe(pb.name)          // both package.json say 'my-app'
    expect(pa.key).not.toBe(pb.key)
    expect(pa.key).toBe(`path:${real(a)}`)
  })

  it('is keyed on name when overridden, so separate repos can be merged on purpose', () => {
    const a = tempTree()
    const b = tempTree()
    expect(resolveProject(a, 'checkout').key).toBe('name:checkout')
    expect(resolveProject(a, 'checkout').key).toBe(resolveProject(b, 'checkout').key)
  })

  it('normalizes symlinked checkouts to one identity', () => {
    const root = tempTree()
    const link = join(mkdtempSync(join(tmpdir(), 'burn0-link-')), 'alias')
    symlinkSync(root, link)
    expect(resolveProject(link).key).toBe(resolveProject(root).key)
  })
})

describe('resolveService', () => {
  it('names the nearest package inside the repo', () => {
    const root = tempTree()
    mkdirSync(join(root, 'apps', 'api', 'src'), { recursive: true })
    writeFileSync(join(root, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api' }))
    expect(resolveService(join(root, 'apps', 'api', 'src'), real(root))).toBe('api')
  })

  it('is null in a single-package repo — there is no sub-dimension to show', () => {
    const root = tempTree()
    expect(resolveService(join(root, 'src', 'deep'), real(root))).toBeNull()
  })

  it('takes an explicit override, for a process not run from its package directory', () => {
    const root = tempTree()
    expect(resolveService(join(root, 'src'), real(root), 'worker')).toBe('worker')
  })
})
