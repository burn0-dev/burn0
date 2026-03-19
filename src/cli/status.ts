import chalk from 'chalk'
import { getApiKey } from '../config/env'
import { readConfig } from '../config/store'
import { detectServices } from '../services/detect'

export async function runStatus(): Promise<void> {
  const cwd = process.cwd()
  const apiKey = getApiKey()
  const config = readConfig(cwd)
  const services = detectServices(cwd)

  const mode = apiKey ? 'cloud (BURN0_API_KEY set)' : 'local (no API key)'
  const project = config.projectName ?? '(not set)'

  console.log()
  console.log(`  Mode:       ${chalk.cyan(mode)}`)
  console.log(`  Project:    ${project}`)

  if (services.length === 0) {
    console.log(`  Services:   ${chalk.dim('none detected')}`)
  } else {
    const unpriced = services.filter(s => !s.autopriced).length
    console.log(`  Services:   ${services.length} tracked${unpriced > 0 ? `, ${unpriced} unpriced` : ''}`)
    for (const svc of services) {
      const icon = svc.autopriced ? chalk.green('✓') : chalk.yellow('◆')
      const note = svc.autopriced ? '(auto-priced)' : '(plan not set)'
      console.log(`    ${icon} ${svc.name.padEnd(16)} ${chalk.dim(note)}`)
    }
  }
  console.log()
}
