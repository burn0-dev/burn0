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

  it('detects Groq SDK', () => {
    const pkg = { dependencies: { 'groq-sdk': '^0.3.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    const result = detectServices(tmpDir)
    expect(result).toContainEqual({
      name: 'groq', package: 'groq-sdk', category: 'llm', autopriced: true,
    })
  })

  it('detects Hugging Face Inference SDK', () => {
    const pkg = { dependencies: { '@huggingface/inference': '^2.0.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    const result = detectServices(tmpDir)
    expect(result).toContainEqual({
      name: 'huggingface', package: '@huggingface/inference', category: 'llm', autopriced: true,
    })
  })

  it('detects Amazon Bedrock SDK', () => {
    const pkg = { dependencies: { '@aws-sdk/client-bedrock-runtime': '^3.0.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    const result = detectServices(tmpDir)
    expect(result).toContainEqual({
      name: 'amazon-bedrock', package: '@aws-sdk/client-bedrock-runtime', category: 'llm', autopriced: true,
    })
  })

})  // ← describe closes here, at the very end