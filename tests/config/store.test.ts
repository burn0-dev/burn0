import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readConfig, writeConfig } from '../../src/config/store'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('config store', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty config when no file exists', () => {
    const config = readConfig(tmpDir)
    expect(config).toEqual({})
  })

  it('writes and reads config', () => {
    const config = { projectName: 'my-app' }
    writeConfig(tmpDir, config)
    expect(readConfig(tmpDir)).toEqual(config)
  })

  it('creates .burn0 directory if it does not exist', () => {
    writeConfig(tmpDir, { projectName: 'test' })
    expect(fs.existsSync(path.join(tmpDir, '.burn0'))).toBe(true)
  })

  it('merges with existing config on write', () => {
    writeConfig(tmpDir, { projectName: 'app' })
    writeConfig(tmpDir, { services: [{ name: 'openai', pricingModel: 'auto' }] })
    const config = readConfig(tmpDir)
    expect(config.projectName).toBe('app')
    expect(config.services).toHaveLength(1)
  })
})
