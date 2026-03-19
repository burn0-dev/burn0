import type { Burn0Event } from '../types'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const WHITE = '\x1b[37m'
const BOLD = '\x1b[1m'

let headerPrinted = false

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return count.toString()
}

function printHeader(): void {
  if (headerPrinted) return
  headerPrinted = true
  process.stdout.write(`\n${DIM}  burn0 ──────────────────────────────────────────────────────────${RESET}\n`)
  process.stdout.write(`${DIM}  TIME       SERVICE        MODEL/ENDPOINT     TOKENS              ${RESET}\n`)
  process.stdout.write(`${DIM}  ─────────────────────────────────────────────────────────────────${RESET}\n`)
}

export function formatEventLine(event: Burn0Event): string {
  const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })

  const service = event.service.length > 12
    ? event.service.substring(0, 12) + '..'
    : event.service

  const modelOrEndpoint = event.model
    ? event.model.length > 22 ? event.model.substring(0, 22) + '..' : event.model
    : event.endpoint.length > 22 ? event.endpoint.substring(0, 22) + '..' : event.endpoint

  let tokens = ''
  if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
    tokens = `${formatTokens(event.tokens_in)} in  ${formatTokens(event.tokens_out)} out`
  }

  return `${DIM}${time}${RESET}  ${CYAN}${service.padEnd(14)}${RESET} ${WHITE}${modelOrEndpoint.padEnd(24)}${RESET} ${GREEN}${tokens}${RESET}`
}

export function formatProcessSummary(events: Burn0Event[], uptimeSeconds: number): string {
  const services: Record<string, { calls: number; tokens_in?: number; tokens_out?: number }> = {}
  for (const event of events) {
    if (!services[event.service]) services[event.service] = { calls: 0 }
    services[event.service].calls++
    if (event.tokens_in !== undefined) services[event.service].tokens_in = (services[event.service].tokens_in ?? 0) + event.tokens_in
    if (event.tokens_out !== undefined) services[event.service].tokens_out = (services[event.service].tokens_out ?? 0) + event.tokens_out
  }
  for (const svc of Object.values(services)) {
    if (svc.tokens_in === undefined) delete svc.tokens_in
    if (svc.tokens_out === undefined) delete svc.tokens_out
  }
  return JSON.stringify({
    burn0: 'process-summary',
    uptime_hours: +(uptimeSeconds / 3600).toFixed(1),
    total_calls: events.length,
    services,
    message: 'Add BURN0_API_KEY to see cost breakdowns → burn0.dev',
  })
}

export function logEvent(event: Burn0Event): void {
  printHeader()
  process.stdout.write(`  ${formatEventLine(event)}\n`)
}
