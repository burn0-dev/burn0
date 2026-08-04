import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface Burn0Config {
  project: string | null
  service: string | null
  retentionDays: { payloads: number; metadata: number }
  bodyCapBytes: number
  ignoreHosts: string[]
  capturePayloads: boolean
  redact: { extraHeaders: string[]; disable: boolean }
  pricingTtlHours: number
  dbPath: string
  /** Auto-root a trace per inbound HTTP request. On by default (D5); set
   *  `traces: { http: false }` to opt out. */
  traceHttp: boolean
  disabled: boolean
}

const CEILINGS = { payloads: 14, metadata: 90 }
let warnedMalformed = false

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Burn0Config {
  let raw: any = {}
  const file = findConfigFile(cwd)
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      // Check if parsed is a plain object (not null, array, or primitive)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        raw = parsed
      } else {
        if (!warnedMalformed) {
          try { process.stderr.write('[burn0] invalid burn0.config.json ignored\n') } catch {}
          warnedMalformed = true
        }
      }
    } catch {
      if (!warnedMalformed) {
        try { process.stderr.write('[burn0] invalid burn0.config.json ignored\n') } catch {}
        warnedMalformed = true
      }
    }
  }
  const num = (v: unknown, dflt: number, max?: number) =>
    typeof v === 'number' && v > 0 ? Math.min(v, max ?? Infinity) : dflt
  const disabled =
    env.BURN0_DISABLED === '1' ||
    (env.NODE_ENV === 'production' && env.BURN0_FORCE !== '1')
  return {
    project: env.BURN0_PROJECT ?? (typeof raw.project === 'string' ? raw.project : null),
    service: env.BURN0_SERVICE ?? (typeof raw.service === 'string' ? raw.service : null),
    retentionDays: {
      payloads: num(raw.retentionDays?.payloads, 7, CEILINGS.payloads),
      metadata: num(raw.retentionDays?.metadata, 30, CEILINGS.metadata),
    },
    bodyCapBytes: num(raw.bodyCapBytes, 1048576),
    ignoreHosts: Array.isArray(raw.ignoreHosts) ? raw.ignoreHosts.filter((h: unknown) => typeof h === 'string') : [],
    capturePayloads: raw.capturePayloads !== false,
    redact: {
      extraHeaders: Array.isArray(raw.redact?.extraHeaders) ? raw.redact.extraHeaders : [],
      disable: raw.redact?.disable === true,
    },
    pricingTtlHours: num(raw.pricingTtlHours, 24),
    dbPath: resolveDbPath(env.BURN0_DB_PATH, raw.dbPath, file),
    traceHttp: env.BURN0_TRACE_HTTP === '0' ? false : raw.traces?.http !== false,
    disabled,
  }
}

/** env → `burn0.config.json` `dbPath` → `~/.burn0/burn0.db`. A relative path in
 *  the file resolves against the file's own directory, so a committed config
 *  stays portable across machines. */
function resolveDbPath(envPath: string | undefined, raw: unknown, configFile: string | null): string {
  if (envPath) return envPath
  if (typeof raw === 'string' && raw.length > 0) {
    return isAbsolute(raw) ? raw : resolve(configFile ? dirname(configFile) : process.cwd(), raw)
  }
  return join(homedir(), '.burn0', 'burn0.db')
}

function findConfigFile(from: string): string | null {
  const homeDir = homedir()
  let dir = from
  while (true) {
    const p = join(dir, 'burn0.config.json')
    if (existsSync(p)) return p
    // Stop after checking home directory
    if (dir === homeDir) return null
    const parent = dirname(dir)
    // Stop at filesystem root
    if (parent === dir) return null
    dir = parent
  }
}
