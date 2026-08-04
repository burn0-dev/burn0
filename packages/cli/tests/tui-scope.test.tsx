import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, ensureProject, insertRows } from '@burn0/core'
import { App } from '../src/tui/App.js'
import { resolveScope } from '../src/scope.js'
import { baseRow } from './helpers/seed.js'

const tick = () => new Promise((r) => setTimeout(r, 20))

function twoProjects() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'burn0-tui-scope-')), 'burn0.db'))
  const alif = ensureProject(db, { key: 'path:/code/alif', name: 'alif', rootPath: '/code/alif', gitRoot: '/code/alif' })
  const beonai = ensureProject(db, { key: 'path:/code/beonai', name: 'beonai', rootPath: '/code/beonai', gitRoot: '/code/beonai' })
  insertRows(db, alif, [baseRow({ normalizedEndpoint: '/alif-only' })], true, 'api')
  insertRows(db, alif, [baseRow({ normalizedEndpoint: '/alif-worker' })], true, 'worker')
  insertRows(db, beonai, [baseRow({ normalizedEndpoint: '/beonai-only' })], true)
  return { db, alif, beonai }
}

const scopeFor = (db: any, projectId: number | null) =>
  resolveScope(db, { all: projectId == null, project: null, service: null }, '/nowhere')

describe('TUI scope', () => {
  it('shows the active scope in the header', async () => {
    const { db } = twoProjects()
    const scope = resolveScope(db, { all: false, project: 'alif', service: null }, '/nowhere')
    const { lastFrame } = render(<App db={db} scope={scope} />)
    await tick()
    expect(lastFrame()).toContain('alif')
  })

  it('scopes the screens, not just the header', async () => {
    const { db } = twoProjects()
    const scope = resolveScope(db, { all: false, project: 'beonai', service: null }, '/nowhere')
    const { lastFrame, stdin } = render(<App db={db} scope={scope} />)
    await tick()
    for (let i = 0; i < 4; i++) { stdin.write('\t'); await tick() }   // to Logs
    expect(lastFrame()).toContain('/beonai-only')
    expect(lastFrame()).not.toContain('/alif-only')
  })

  it('p cycles the project scope', async () => {
    const { db } = twoProjects()
    const { lastFrame, stdin } = render(<App db={db} scope={scopeFor(db, null)} />)
    await tick()
    expect(lastFrame()).toContain('all projects')
    stdin.write('p')
    await tick()
    expect(lastFrame()).not.toContain('all projects')
  })

  it('s cycles the service filter, and only where more than one service exists', async () => {
    const { db } = twoProjects()
    const scope = resolveScope(db, { all: false, project: 'alif', service: null }, '/nowhere')
    const { lastFrame, stdin } = render(<App db={db} scope={scope} />)
    await tick()
    for (let i = 0; i < 4; i++) { stdin.write('\t'); await tick() }   // Logs
    expect(lastFrame()).toContain('/alif-only')
    expect(lastFrame()).toContain('/alif-worker')

    stdin.write('s')
    await tick()
    expect(lastFrame()).toContain('api')
    expect(lastFrame()).toContain('/alif-only')
    expect(lastFrame()).not.toContain('/alif-worker')
  })
})
