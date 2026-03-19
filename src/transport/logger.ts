import type { Burn0Event } from '../types'
import { estimateLocalCost, type CostEstimate } from './local-pricing'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const WHITE = '\x1b[37m'
const BOLD = '\x1b[1m'
const ORANGE = '\x1b[38;2;250;93;25m'
const BG_DARK = '\x1b[48;2;30;30;30m'
const GRAY = '\x1b[90m'

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
  return `$${cost.toFixed(6)}`
}

function formatCostEstimate(estimate: CostEstimate): string {
  switch (estimate.type) {
    case 'priced':
      return `${GREEN}${formatCost(estimate.cost)}${RESET}`
    case 'free':
      return `${GRAY}free${RESET}`
    case 'no-tokens':
      return `${YELLOW}no usage${RESET}`
    case 'fixed-tier':
      return `${YELLOW}plan?${RESET}`
    case 'unknown':
      return `${GRAY}untracked${RESET}`
  }
}

function printHeader(): void {
  if (headerPrinted) return
  headerPrinted = true
  process.stdout.write(`\n`)
  process.stdout.write(`  ${ORANGE}${BOLD} burn0 ${RESET} ${DIM}live cost tracking${RESET}\n`)
  process.stdout.write(`\n`)
  process.stdout.write(`  ${GRAY}SERVICE          ENDPOINT / MODEL              USAGE          COST${RESET}\n`)
  process.stdout.write(`  ${GRAY}${'─'.repeat(68)}${RESET}\n`)
}

function printSessionTotal(): void {
  process.stdout.write(`  ${GRAY}${'─'.repeat(68)}${RESET}\n`)
  if (sessionTotal > 0) {
    process.stdout.write(`  ${GRAY}${eventCount} calls${RESET}                                              ${ORANGE}${BOLD}${formatCost(sessionTotal)}${RESET}\n`)
  } else {
    process.stdout.write(`  ${GRAY}${eventCount} calls${RESET}                                              ${GRAY}$0${RESET}\n`)
  }
  process.stdout.write(`  ${GRAY}${'─'.repeat(68)}${RESET}\n`)
}

export function formatEventLine(event: Burn0Event): string {
  const service = event.service.length > 15
    ? event.service.substring(0, 14) + '.'
    : event.service

  const modelOrEndpoint = event.model
    ? (event.model.length > 29 ? event.model.substring(0, 28) + '.' : event.model)
    : (event.endpoint.length > 29 ? event.endpoint.substring(0, 28) + '.' : event.endpoint)

  let usage = ''
  if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
    usage = `${formatTokens(event.tokens_in)} → ${formatTokens(event.tokens_out)}`
  }

  const estimate = estimateLocalCost(event)
  const costStr = formatCostEstimate(estimate)

  return `  ${CYAN}${service.padEnd(16)}${RESET} ${WHITE}${modelOrEndpoint.padEnd(30)}${RESET}${GRAY}${usage.padEnd(15)}${RESET}${costStr}`
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

  const estimate = estimateLocalCost(event)
  if (estimate.type === 'priced' && estimate.cost > 0) {
    sessionTotal += estimate.cost
  }
  eventCount++

  process.stdout.write(`${formatEventLine(event)}\n`)

  // Show running total every 5 events
  if (eventCount % 5 === 0) {
    printSessionTotal()
  }
}
