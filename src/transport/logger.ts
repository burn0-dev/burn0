import type { Burn0Event } from '../types'

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return count.toString()
}

export function formatEventLine(event: Burn0Event): string {
  const parts: string[] = []
  const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })
  parts.push(time.padEnd(10))
  parts.push(event.service.padEnd(14))
  if (event.model) {
    parts.push(event.model.padEnd(18))
  } else {
    parts.push(event.endpoint.padEnd(18))
  }
  if (event.tokens_in !== undefined && event.tokens_out !== undefined) {
    parts.push(`(${formatTokens(event.tokens_in)} in · ${formatTokens(event.tokens_out)} out)`)
  }
  return parts.join('')
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
  process.stdout.write(` ${formatEventLine(event)}\n`)
}
