import type { Burn0Event } from '../types'
import { estimateLocalCost } from './local-pricing'

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const BOLD = '\x1b[1m'
const ORANGE = '\x1b[38;2;250;93;25m'
const GRAY = '\x1b[90m'
const CLEAR_LINE = '\x1b[2K\r'

export interface TickerInit {
  todayCost: number
  todayCalls: number
  perServiceCosts: Record<string, number>
}

export interface Ticker {
  tick: (event: Burn0Event) => void
  printExitSummary: () => void
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(6)}`
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function formatServiceBreakdown(perServiceCosts: Record<string, number>, maxWidth: number): string {
  const sorted = Object.entries(perServiceCosts)
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])

  if (sorted.length === 0) return ''

  const parts: string[] = []
  let currentWidth = 0

  let shown = 0
  for (let i = 0; i < sorted.length && shown < 3; i++) {
    const [name, cost] = sorted[i]
    const part = `${name}: ${formatCost(cost)}`
    if (currentWidth + part.length + 3 > maxWidth && shown > 0) {
      break
    }
    parts.push(part)
    currentWidth += part.length + 3
    shown++
  }

  const remaining = sorted.length - shown
  if (remaining > 0) {
    parts.push(`+${remaining} more`)
  }

  return parts.join(' · ')
}

export function createTicker(init: TickerInit): Ticker {
  let sessionCost = 0
  let sessionCalls = 0
  const sessionStartTime = Date.now()

  let todayCost = init.todayCost
  let todayCalls = init.todayCalls
  const perServiceCosts = { ...init.perServiceCosts }

  let exitPrinted = false

  let pricedCalls = 0
  let lastLineLen = 0

  function render(): void {
    if (!process.stderr.isTTY) return
    if (todayCalls === 0) return

    let content: string
    if (pricedCalls === 0 && todayCost === 0) {
      content = `  burn0 ▸ ${todayCalls} calls today`
    } else {
      const breakdown = formatServiceBreakdown(perServiceCosts, 40)
      const breakdownPart = breakdown ? ` ── ${breakdown}` : ''
      content = `  burn0 ▸ ${formatCost(todayCost)} today (${todayCalls} calls)${breakdownPart}`
    }

    // Pad with spaces to clear any leftover characters from the previous render
    const pad = lastLineLen > content.length ? ' '.repeat(lastLineLen - content.length) : ''
    lastLineLen = content.length

    // Apply colors after measuring length (ANSI codes don't take terminal width)
    let colored: string
    if (pricedCalls === 0 && todayCost === 0) {
      colored = `  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GRAY}${todayCalls} calls today${RESET}`
    } else {
      const breakdown = formatServiceBreakdown(perServiceCosts, 40)
      const breakdownPart = breakdown ? ` ${GRAY}──${RESET} ${breakdown}` : ''
      colored = `  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GREEN}${formatCost(todayCost)}${RESET} ${GRAY}today (${todayCalls} calls)${RESET}${breakdownPart}`
    }

    process.stderr.write(`\r${colored}${pad}`)
  }

  function tick(event: Burn0Event): void {
    const estimate = estimateLocalCost(event)

    todayCalls++
    sessionCalls++

    if (estimate.type === 'priced' && estimate.cost > 0) {
      todayCost += estimate.cost
      sessionCost += estimate.cost
      pricedCalls++
      perServiceCosts[event.service] = (perServiceCosts[event.service] ?? 0) + estimate.cost
    }

    render()
  }

  function printExitSummary(): void {
    if (!process.stderr.isTTY) return
    if (sessionCalls === 0) return
    if (exitPrinted) return
    exitPrinted = true

    const duration = formatDuration(Date.now() - sessionStartTime)
    let line: string
    if (pricedCalls === 0 && sessionCost === 0) {
      line = `\n  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GRAY}session: ${sessionCalls} calls (${duration})${RESET} ${GRAY}──${RESET} ${GRAY}today: ${todayCalls} calls${RESET}\n`
    } else {
      line = `\n  ${ORANGE}${BOLD}burn0 ▸${RESET} ${GRAY}session:${RESET} ${GREEN}${formatCost(sessionCost)}${RESET} ${GRAY}(${sessionCalls} calls, ${duration})${RESET} ${GRAY}──${RESET} ${GRAY}today:${RESET} ${GREEN}${formatCost(todayCost)}${RESET}\n`
    }

    process.stderr.write(line)
  }

  return { tick, printExitSummary }
}
