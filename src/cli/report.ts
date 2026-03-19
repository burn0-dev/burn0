import chalk from 'chalk'
import { LocalLedger } from '../transport/local'

export async function runReport(): Promise<void> {
  const cwd = process.cwd()
  const ledger = new LocalLedger(cwd)
  const events = ledger.read()

  if (events.length === 0) {
    console.log(chalk.dim("\n  No data yet. Run your app with `import 'burn0'` to start tracking.\n"))
    return
  }

  const byService: Record<string, { calls: number; tokens_in: number; tokens_out: number }> = {}
  for (const event of events) {
    if (!byService[event.service]) {
      byService[event.service] = { calls: 0, tokens_in: 0, tokens_out: 0 }
    }
    byService[event.service].calls++
    byService[event.service].tokens_in += event.tokens_in ?? 0
    byService[event.service].tokens_out += event.tokens_out ?? 0
  }

  const sorted = Object.entries(byService).sort((a, b) => b[1].calls - a[1].calls)
  const maxCalls = Math.max(...sorted.map(([, s]) => s.calls))

  console.log(chalk.dim(`\n  Last 7 days: ${events.length} total calls\n`))

  for (const [name, stats] of sorted) {
    const barLength = Math.round((stats.calls / maxCalls) * 20)
    const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength)
    const callsStr = `${stats.calls} calls`.padEnd(12)
    console.log(`  ${name.padEnd(16)} ${callsStr} ${chalk.cyan(bar)}`)
  }
  console.log()
}
