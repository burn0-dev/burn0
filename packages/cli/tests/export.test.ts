import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRows } from '@burn0/core'
import { runExport } from '../src/commands/export.js'
import { runProjects } from '../src/commands/projects.js'
import { seedDb, baseRow } from './helpers/seed.js'

describe('runExport', () => {
  it('writes JSON array of metadata rows to stdout', () => {
    const { db } = seedDb([{}, { entity: 'Stripe', entityClass: 'general' }])
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true })
    runExport('json', null, { db })
    spy.mockRestore()
    const rows = JSON.parse(chunks.join(''))
    expect(rows.length).toBe(2)
    expect(rows[0]).toHaveProperty('entity')
    expect(rows[0]).toHaveProperty('cost_usd')
    expect(rows[0]).not.toHaveProperty('req_body')  // metadata only
  })
  it('writes CSV with header to file', () => {
    const { db } = seedDb()
    const out = join(mkdtempSync(join(tmpdir(), 'burn0-exp-')), 'dump.csv')
    runExport('csv', out, { db })
    const text = readFileSync(out, 'utf8')
    const [header, first] = text.trim().split('\n')
    expect(header.split(',')).toContain('entity')
    expect(first).toContain('OpenAI')
  })

  it('dumps only the scoped project, not every project on the machine', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-exp-scope-')), 'burn0.db'))
    const mine = ensureProject(db, { key: 'path:/mine', name: 'mine', rootPath: '/mine', gitRoot: null })
    const theirs = ensureProject(db, { key: 'path:/theirs', name: 'theirs', rootPath: '/theirs', gitRoot: null })
    insertRows(db, mine, [baseRow(), baseRow()], false)
    insertRows(db, theirs, [baseRow()], false)

    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true })
    runExport('json', null, { db, scope: { projectIds: [mine], services: null } })
    spy.mockRestore()
    const rows = JSON.parse(chunks.join(''))
    expect(rows.length).toBe(2)
    expect(rows.every((r: any) => r.project_id === mine)).toBe(true)
  })

  it('does not delete anything — reads are not a retention trigger', () => {
    const { db } = seedDb([{ startedAt: Date.now() - 400 * 86_400_000 }])
    const before = db.prepare('SELECT COUNT(*) c FROM requests').get().c
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    runExport('json', null, { db })
    spy.mockRestore()
    expect(db.prepare('SELECT COUNT(*) c FROM requests').get().c).toBe(before)
  })
})

describe('runProjects', () => {
  it('lists every project with its path, services and call count', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-projlist-')), 'burn0.db'))
    const mono = ensureProject(db, { key: 'path:/code/mono', name: 'mono', rootPath: '/code/mono', gitRoot: '/code/mono' })
    insertRows(db, mono, [baseRow(), baseRow()], false, 'api')
    insertRows(db, mono, [baseRow()], false, 'worker')

    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true })
    runProjects({ db })
    spy.mockRestore()
    const out = chunks.join('')
    expect(out).toContain('mono')
    expect(out).toContain('/code/mono')
    expect(out).toContain('api, worker')
    expect(out).toContain('3 calls')
  })

  it('says so when there is nothing yet', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-projempty-')), 'burn0.db'))
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true })
    runProjects({ db })
    spy.mockRestore()
    expect(chunks.join('')).toContain('no projects yet')
  })
})
