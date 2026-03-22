import { select, checkbox, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { detectServices } from '../services/detect'
import { scanCodebase } from '../services/scan'
import { writeConfig } from '../config/store'
import { SERVICE_CATALOG } from '../services/catalog'
import { promptApiKey } from './api-key'

export async function runInit(): Promise<void> {
  try {
    await _runInit()
  } catch (err: any) {
    if (err.name === 'ExitPromptError' || err.message?.includes('SIGINT')) {
      console.log('\n\n  Cancelled. Run `npx burn0 init` when ready.\n')
      process.exit(0)
    }
    throw err
  }
}

async function _runInit(): Promise<void> {
  const cwd = process.cwd()

  console.log(chalk.dim('\n  burn0 — track every API cost\n'))

  // Step 1: API key
  const apiKey = await promptApiKey(cwd)

  // Step 2: Auto-detect + confirm services
  console.log(chalk.dim('\n  Scanning your project...\n'))

  const pkgServices = detectServices(cwd)
  const scannedServices = scanCodebase(cwd)
  const detectedNames = new Set(pkgServices.map(s => s.name))
  const newFromScan = scannedServices.filter(s => !detectedNames.has(s.name))

  // Build unified list of detected services
  const allDetected: { name: string; displayName: string; autopriced: boolean }[] = []

  for (const svc of pkgServices) {
    const entry = SERVICE_CATALOG.find(c => c.name === svc.name)
    allDetected.push({
      name: svc.name,
      displayName: entry?.displayName ?? svc.name,
      autopriced: svc.autopriced,
    })
  }
  for (const svc of newFromScan) {
    const entry = SERVICE_CATALOG.find(c => c.name === svc.name)
    allDetected.push({
      name: svc.name,
      displayName: entry?.displayName ?? svc.name,
      autopriced: entry?.pricingType !== 'fixed',
    })
  }

  let selectedServices: string[] = []

  if (allDetected.length > 0) {
    const ADD_MORE = '__add_more__'

    const choices = allDetected.map(svc => ({
      name: `${svc.displayName.padEnd(20)} ${svc.autopriced ? chalk.dim('auto-priced') : chalk.yellow('select plan ▸')}`,
      value: svc.name,
      checked: true,
    }))
    choices.push({ name: chalk.cyan('+ Add more services...'), value: ADD_MORE, checked: false })

    selectedServices = await checkbox({
      message: 'Detected services (uncheck to exclude):',
      choices,
    })

    // Handle "Add more" selection
    if (selectedServices.includes(ADD_MORE)) {
      selectedServices = selectedServices.filter(s => s !== ADD_MORE)
      const additionalServices = SERVICE_CATALOG.filter(s =>
        !allDetected.some(d => d.name === s.name)
      )

      if (additionalServices.length > 0) {
        const llmChoices = additionalServices
          .filter(s => s.category === 'llm')
          .map(s => ({ name: s.displayName, value: s.name }))
        const apiChoices = additionalServices
          .filter(s => s.category === 'api')
          .map(s => ({ name: s.displayName, value: s.name }))
        const infraChoices = additionalServices
          .filter(s => s.category === 'infra')
          .map(s => ({ name: s.displayName, value: s.name }))

        const additional = await checkbox({
          message: 'Select additional services:',
          choices: [
            ...(llmChoices.length ? [{ name: chalk.bold.blue('── LLM Providers ──'), value: '__sep', disabled: true as any }] : []),
            ...llmChoices,
            ...(apiChoices.length ? [{ name: chalk.bold.magenta('── API Services ──'), value: '__sep2', disabled: true as any }] : []),
            ...apiChoices,
            ...(infraChoices.length ? [{ name: chalk.bold.yellow('── Infrastructure ──'), value: '__sep3', disabled: true as any }] : []),
            ...infraChoices,
          ],
        })
        selectedServices.push(...additional.filter(s => !s.startsWith('__sep')))
      }
    }
  } else {
    console.log(chalk.dim('  No services detected.\n'))
    const llmChoices = SERVICE_CATALOG
      .filter(s => s.category === 'llm')
      .map(s => ({ name: s.displayName, value: s.name }))
    const apiChoices = SERVICE_CATALOG
      .filter(s => s.category === 'api')
      .map(s => ({ name: s.displayName, value: s.name }))
    const infraChoices = SERVICE_CATALOG
      .filter(s => s.category === 'infra')
      .map(s => ({ name: s.displayName, value: s.name }))

    selectedServices = await checkbox({
      message: 'Select the services you use:',
      choices: [
        ...(llmChoices.length ? [{ name: chalk.bold.blue('── LLM Providers ──'), value: '__sep', disabled: true as any }] : []),
        ...llmChoices,
        ...(apiChoices.length ? [{ name: chalk.bold.magenta('── API Services ──'), value: '__sep2', disabled: true as any }] : []),
        ...apiChoices,
        ...(infraChoices.length ? [{ name: chalk.bold.yellow('── Infrastructure ──'), value: '__sep3', disabled: true as any }] : []),
        ...infraChoices,
      ],
    })
    selectedServices = selectedServices.filter(s => !s.startsWith('__sep'))
  }

  // Prompt for fixed-tier service plans
  const serviceConfigs: { name: string; plan?: string; monthlyCost?: number }[] = []

  for (const name of selectedServices) {
    const entry = SERVICE_CATALOG.find(c => c.name === name)
    if (entry?.pricingType === 'fixed' && entry.plans) {
      const plan = await select({
        message: `${entry.displayName} — which plan?`,
        choices: [
          ...entry.plans.map(p => ({ name: p.name, value: p.value })),
          { name: 'Skip', value: 'skip' },
        ],
      })
      if (plan !== 'skip') {
        const selected = entry.plans.find(p => p.value === plan)
        serviceConfigs.push({ name, plan, monthlyCost: selected?.monthly })
      } else {
        serviceConfigs.push({ name })
      }
    } else {
      serviceConfigs.push({ name })
    }
  }

  // Read project name from package.json
  let projectName = 'my-project'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'))
    if (pkg.name) projectName = pkg.name
  } catch {}

  // Write config
  writeConfig(cwd, {
    projectName,
    services: serviceConfigs.map(s => ({
      name: s.name,
      pricingModel: s.plan ? 'fixed-tier' as const : 'auto' as const,
      plan: s.plan,
      monthlyCost: s.monthlyCost,
    })),
  })

  // Ensure .burn0/ in gitignore
  ensureGitignore(cwd, '.burn0/')

  // Check .env in gitignore
  const gitignorePath = path.join(cwd, '.gitignore')
  let gitignoreContent = ''
  try { gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8') } catch {}
  if (!gitignoreContent.includes('.env')) {
    const addEnv = await confirm({ message: '.env is not in .gitignore. Add it?' })
    if (addEnv) ensureGitignore(cwd, '.env')
  }

  // Step 3: Done
  console.log('')
  console.log(chalk.green('  ✓ Setup complete'))
  console.log('')
  console.log(chalk.dim('  Add this to your entry file:'))
  console.log(chalk.white("    import '@burn0/burn0'"))
  console.log('')
  console.log(chalk.dim('  Then run your app to see costs.'))
  console.log('')
}

function ensureGitignore(cwd: string, entry: string): void {
  const gitignorePath = path.join(cwd, '.gitignore')
  let content = ''
  try { content = fs.readFileSync(gitignorePath, 'utf-8') } catch {}
  if (!content.includes(entry)) {
    content += `${content && !content.endsWith('\n') ? '\n' : ''}${entry}\n`
    fs.writeFileSync(gitignorePath, content)
  }
}
