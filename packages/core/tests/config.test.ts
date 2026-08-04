import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config/index.js'

describe('loadConfig', () => {
  it('returns defaults with no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    const cfg = loadConfig(dir, {})
    expect(cfg.retentionDays).toEqual({ payloads: 7, metadata: 30 })
    expect(cfg.bodyCapBytes).toBe(1048576)
    expect(cfg.capturePayloads).toBe(true)
    expect(cfg.redact.disable).toBe(false)
    expect(cfg.dbPath).toBe(join(homedir(), '.burn0', 'burn0.db'))
    expect(cfg.disabled).toBe(false)
  })
  it('reads burn0.config.json and clamps retention to ceilings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    writeFileSync(join(dir, 'burn0.config.json'), JSON.stringify({
      project: 'alif-backend',
      retentionDays: { payloads: 99, metadata: 999 },
      ignoreHosts: ['localhost'],
    }))
    const cfg = loadConfig(dir, {})
    expect(cfg.project).toBe('alif-backend')
    expect(cfg.retentionDays).toEqual({ payloads: 14, metadata: 90 })
    expect(cfg.ignoreHosts).toEqual(['localhost'])
  })
  it('malformed config falls back to defaults without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    writeFileSync(join(dir, 'burn0.config.json'), '{not json')
    expect(() => loadConfig(dir, {})).not.toThrow()
    expect(loadConfig(dir, {}).project).toBeNull()
  })
  it('env overrides win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    const cfg = loadConfig(dir, { BURN0_PROJECT: 'from-env', BURN0_DB_PATH: '/x/y.db', BURN0_DISABLED: '1' })
    expect(cfg.project).toBe('from-env')
    expect(cfg.dbPath).toBe('/x/y.db')
    expect(cfg.disabled).toBe(true)
  })
  it('NODE_ENV=production disables unless BURN0_FORCE=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    expect(loadConfig(dir, { NODE_ENV: 'production' }).disabled).toBe(true)
    expect(loadConfig(dir, { NODE_ENV: 'production', BURN0_FORCE: '1' }).disabled).toBe(false)
  })
  it('config file containing null falls back to defaults without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    writeFileSync(join(dir, 'burn0.config.json'), 'null')
    expect(() => loadConfig(dir, {})).not.toThrow()
    expect(loadConfig(dir, {}).project).toBeNull()
    expect(loadConfig(dir, {}).retentionDays).toEqual({ payloads: 7, metadata: 30 })
  })
  it('config file containing non-object JSON falls back to defaults without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    writeFileSync(join(dir, 'burn0.config.json'), '5')
    expect(() => loadConfig(dir, {})).not.toThrow()
    expect(loadConfig(dir, {}).retentionDays).toEqual({ payloads: 7, metadata: 30 })
  })
  it('finds config file in parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    const childDir = join(dir, 'subdir')
    mkdirSync(childDir, { recursive: true })
    writeFileSync(join(dir, 'burn0.config.json'), JSON.stringify({
      project: 'parent-config',
      bodyCapBytes: 2000000,
    }))
    const cfg = loadConfig(childDir, {})
    expect(cfg.project).toBe('parent-config')
    expect(cfg.bodyCapBytes).toBe(2000000)
  })

  it('dbPath is settable from the config file, and env still wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    writeFileSync(join(dir, 'burn0.config.json'), JSON.stringify({ dbPath: '/srv/shared/burn0.db' }))
    expect(loadConfig(dir, {}).dbPath).toBe('/srv/shared/burn0.db')
    expect(loadConfig(dir, { BURN0_DB_PATH: '/tmp/override.db' }).dbPath).toBe('/tmp/override.db')
  })

  it('a relative dbPath resolves against the config file, so a committed config is portable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    const childDir = join(dir, 'packages', 'api')
    mkdirSync(childDir, { recursive: true })
    writeFileSync(join(dir, 'burn0.config.json'), JSON.stringify({ dbPath: '.burn0/local.db' }))
    // resolved against the config file's directory, not the process cwd
    expect(loadConfig(childDir, {}).dbPath).toBe(join(dir, '.burn0', 'local.db'))
  })

  it('defaults dbPath to ~/.burn0/burn0.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    expect(loadConfig(dir, {}).dbPath).toBe(join(homedir(), '.burn0', 'burn0.db'))
  })

  it('service comes from BURN0_SERVICE or the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burn0-cfg-'))
    expect(loadConfig(dir, {}).service).toBeNull()
    writeFileSync(join(dir, 'burn0.config.json'), JSON.stringify({ service: 'worker' }))
    expect(loadConfig(dir, {}).service).toBe('worker')
    expect(loadConfig(dir, { BURN0_SERVICE: 'api' }).service).toBe('api')
  })
})
