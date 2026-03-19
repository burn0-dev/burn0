import fs from 'node:fs'
import path from 'node:path'
import type { Burn0Event } from '../types'

const BURN0_DIR = '.burn0'
const LEDGER_FILE = 'costs.jsonl'
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export class LocalLedger {
  private filePath: string
  private dirPath: string

  constructor(projectRoot: string) {
    this.dirPath = path.join(projectRoot, BURN0_DIR)
    this.filePath = path.join(this.dirPath, LEDGER_FILE)
  }

  write(event: Burn0Event): void {
    this.ensureDir()
    this.rotateIfNeeded()
    fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n')
  }

  read(): Burn0Event[] {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8').trim()
      if (!content) return []
      return content.split('\n').map((line) => JSON.parse(line) as Burn0Event)
    } catch { return [] }
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dirPath)) fs.mkdirSync(this.dirPath, { recursive: true })
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath)
      if (stat.size > MAX_FILE_SIZE) { this.pruneOldEntries(); return }
    } catch { return }
    const events = this.read()
    if (events.length > 0) {
      const oldest = new Date(events[0].timestamp).getTime()
      if (Date.now() - oldest > MAX_AGE_MS) this.pruneOldEntries()
    }
  }

  private pruneOldEntries(): void {
    const cutoff = Date.now() - MAX_AGE_MS
    const events = this.read().filter(e => new Date(e.timestamp).getTime() > cutoff)
    const content = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
    fs.writeFileSync(this.filePath, content)
  }
}
