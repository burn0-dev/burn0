import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { detectServices } from '../../src/services/detect'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('detectServices', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-detect-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('detects known SDKs from package.json dependencies', () => {
    const pkg = { dependencies: { 'openai': '^4.0.0', 'express': '^4.18.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    const result = detectServices(tmpDir)
    expect(result).toContainEqual({
      name: 'openai', package: 'openai', category: 'llm', autopriced: true,
    })
    expect(result.find(s => s.name === 'express')).toBeUndefined()
  })

  it('detects from devDependencies too', () => {
    const pkg = { devDependencies: { '@anthropic-ai/sdk': '^1.0.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    const result = detectServices(tmpDir)
    expect(result).toContainEqual({
      name: 'anthropic', package: '@anthropic-ai/sdk', category: 'llm', autopriced: true,
    })
  })

  it('returns empty array when no package.json exists', () => {
    expect(detectServices(tmpDir)).toEqual([])
  })

  it('returns empty array when no known SDKs found', () => {
    const pkg = { dependencies: { express: '^4.18.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    expect(detectServices(tmpDir)).toEqual([])
  })
})
