import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('status command', () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-status-')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); vi.unstubAllEnvs() })

  it('detects services for status display', async () => {
    const pkg = { name: 'test-app', dependencies: { openai: '^4.0.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    const { detectServices } = await import('../../src/services/detect')
    const services = detectServices(tmpDir)
    expect(services.length).toBeGreaterThan(0)
    expect(services[0].name).toBe('openai')
  })
})
