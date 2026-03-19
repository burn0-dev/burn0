import type { Burn0Event } from '../types'
import { estimateLocalCost } from './local-pricing'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const WHITE = '\x1b[37m'
const BOLD = '\x1b[1m'
const ORANGE = '\x1b[38;2;250;93;25m' // #FA5D19

let headerPrinted = false
let sessionTotal = 0
let eventCount = 0

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return count.toString()
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(4)}`
  if (cost >= 0.0001) return `$${cost.toFixed(6)}`
  return `$${cost.toFixed(8)}`
}

function printHeader(): void {
  if (headerPrinted) return
  headerPrinted = true
  process.stdout.write(`\n`)
  process.stdout.write(`  ${ORANGE}${BOLD}burn0${RESET} ${DIM}tracking costs...${RESET}\n`)
  process.stdout.write(`  ${DIM}─────────────────────────────────────────────────────────────────────${RESET}\n`)
  process.stdout.write(`  ${DIM}  SERVICE         MODEL / ENDPOINT          TOKENS            COST${RESET}\n`)
  process.stdout.write(`  ${DIM}─────────────────────────────────────────────────────────────────────${RESET}\n`)
}

export function formatEventLine(event: Burn0Event): string {
  const service = event.service.length > 13
    ? event.service.substring(0, 13) + '..'
    : event.service

  const modelOrEndpoint = event.model
    ? event.model.length > 25 ? event.model.substring(0, 25) + '..' : event.model
    : event.endpoint.length > 25 ? event.endpoint.substring(0, 25) + '..' : event.endpoint

  let tokens = ''
  if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
    tokens = `${formatTokens(event.tokens_in)}→${formatTokens(event.tokens_out)}`
  }

  const cost = estimateLocalCost(event)
  let costStr = ''
  if (cost !== null && cost > 0) {
    costStr = `${GREEN}${formatCost(cost)}${RESET}`
  } else if (cost === 0) {
    costStr = `${DIM}free${RESET}`
  } else {
    costStr = `${DIM}--${RESET}`
  }

  return `  ${CYAN}${service.padEnd(15)}${RESET} ${WHITE}${modelOrEndpoint.padEnd(27)}${RESET} ${DIM}${tokens.padEnd(15)}${RESET}  ${costStr}`
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

  const cost = estimateLocalCost(event)
  if (cost !== null && cost > 0) {
    sessionTotal += cost
  }
  eventCount++

  process.stdout.write(`${formatEventLine(event)}\n`)

  // Print running total every 5 events or when cost is significant
  if (eventCount % 5 === 0 || (cost !== null && cost > 0.01)) {
    process.stdout.write(`  ${DIM}─────────────────────────────────────────────────────────────────────${RESET}\n`)
    process.stdout.write(`  ${DIM}  session total: ${RESET}${ORANGE}${BOLD}${formatCost(sessionTotal)}${RESET}${DIM} (${eventCount} calls)${RESET}\n`)
    process.stdout.write(`  ${DIM}─────────────────────────────────────────────────────────────────────${RESET}\n`)
  }
}
