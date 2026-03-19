import fs from 'node:fs'
import path from 'node:path'
import type { Burn0Config } from '../types'

const CONFIG_DIR = '.burn0'
const CONFIG_FILE = 'config.json'

function configPath(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_DIR, CONFIG_FILE)
}

export function readConfig(projectRoot: string): Burn0Config {
  const filePath = configPath(projectRoot)
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as Burn0Config
  } catch {
    return {}
  }
}

export function writeConfig(projectRoot: string, updates: Partial<Burn0Config>): void {
  const dirPath = path.join(projectRoot, CONFIG_DIR)
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
  const existing = readConfig(projectRoot)
  const merged = { ...existing, ...updates }
  fs.writeFileSync(configPath(projectRoot), JSON.stringify(merged, null, 2) + '\n')
}
