import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { detectServices } from '../../src/services/detect'

describe('init wizard helpers', () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn0-init-')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('detectServices finds SDKs in the project', () => {
    const pkg = { dependencies: { openai: '^4.0.0', stripe: '^14.0.0' } }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))
    const services = detectServices(tmpDir)
    expect(services).toHaveLength(2)
    expect(services.map(s => s.name)).toContain('openai')
    expect(services.map(s => s.name)).toContain('stripe')
  })
})
