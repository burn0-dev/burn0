import { input, select, confirm, checkbox } from '@inquirer/prompts'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { detectServices } from '../services/detect'
import { scanCodebase } from '../services/scan'
import { writeConfig } from '../config/store'
import { SERVICE_CATALOG } from '../services/catalog'
import type { ServiceConfig } from '../types'

export async function runInit(): Promise<void> {
  try {
    await _runInit()
  } catch (err: any) {
    if (err.name === 'ExitPromptError' || err.message?.includes('SIGINT')) {
      console.log('\n\n  Cancelled. Run `burn0 init` again when ready.\n')
      process.exit(0)
    }
    throw err
  }
}

async function _runInit(): Promise<void> {
  const cwd = process.cwd()

  const o = chalk.hex('#FA5D19')
  const banner = `
  ${'bbbbbbbb'}
  ${'b::::::b'}                                                                        ${o('000000000')}
  ${'b::::::b'}                                                                      ${o('00:::::::::00')}
  ${'b::::::b'}                                                                    ${o('00:::::::::::::00')}
  ${' b:::::b'}                                                                   ${o('0:::::::000:::::::0')}
  ${' b:::::bbbbbbbbb'}    ${'uuuuuu    uuuuuu'} ${'rrrrr   rrrrrrrrr'}   ${'nnnn  nnnnnnnn'}    ${o('0::::::0   0::::::0')}
  ${' b::::::::::::::bb'}  ${'u::::u    u::::u'} ${'r::::rrr:::::::::r'}  ${'n:::nn::::::::nn'}  ${o('0:::::0     0:::::0')}
  ${' b::::::::::::::::b'} ${'u::::u    u::::u'} ${'r:::::::::::::::::r'} ${'n::::::::::::::nn'} ${o('0:::::0     0:::::0')}
  ${' b:::::bbbbb:::::::b'}${'u::::u    u::::u'} ${'rr::::::rrrrr::::::r'}${'nn:::::::::::::::n'}${o('0:::::0 000 0:::::0')}
  ${' b:::::b    b::::::b'}${'u::::u    u::::u'}  ${'r:::::r     r:::::r'}  ${'n:::::nnnn:::::n'}${o('0:::::0 000 0:::::0')}
  ${' b:::::b     b:::::b'}${'u::::u    u::::u'}  ${'r:::::r     rrrrrrr'}  ${'n::::n    n::::n'}${o('0:::::0     0:::::0')}
  ${' b:::::b     b:::::b'}${'u::::u    u::::u'}  ${'r:::::r'}              ${'n::::n    n::::n'}${o('0:::::0     0:::::0')}
  ${' b:::::b     b:::::b'}${'u:::::uuuu:::::u'}  ${'r:::::r'}              ${'n::::n    n::::n'}${o('0::::::0   0::::::0')}
  ${' b:::::bbbbbb::::::b'}${'u:::::::::::::::uu'}${'r:::::r'}              ${'n::::n    n::::n'}${o('0:::::::000:::::::0')}
  ${' b::::::::::::::::b'}  ${'u:::::::::::::::u'}${'r:::::r'}              ${'n::::n    n::::n'} ${o('00:::::::::::::00')}
  ${' b:::::::::::::::b'}    ${'uu::::::::uu:::u'}${'r:::::r'}              ${'n::::n    n::::n'}   ${o('00:::::::::00')}
  ${' bbbbbbbbbbbbbbbb'}       ${'uuuuuuuu  uuuu'}${'rrrrrrr'}              ${'nnnnnn    nnnnnn'}     ${o('000000000')}
`
  console.log(banner)
  console.log(chalk.dim('  Track every API call. Know your costs.\n'))

  console.log(chalk.dim('  Scanning your project...\n'))

  const services = detectServices(cwd)

  if (services.length === 0) {
    console.log(chalk.yellow('  No known API services found in package.json.'))
    console.log(chalk.dim('  burn0 will still track any outgoing HTTP calls.\n'))
  } else {
    console.log(chalk.bold(`  Detected ${services.length} services:\n`))
    console.log(chalk.dim('  ┌──────────────────────────────────────────────┐'))
    for (const svc of services) {
      const label = svc.autopriced ? chalk.green('  ✓') : chalk.yellow('  ◆')
      const category = svc.category === 'llm' ? chalk.blue('LLM') :
                       svc.autopriced ? chalk.magenta('API') : chalk.yellow('API')
      const pricing = svc.autopriced ? chalk.dim('auto-priced') : chalk.yellow('plan needed')
      console.log(`${label}  ${svc.package.padEnd(25)} ${category}  ${pricing}`)
    }
    console.log(chalk.dim('  └──────────────────────────────────────────────┘'))
    console.log()
  }

  // Phase 2: Scan codebase for API calls and env vars
  console.log(chalk.dim('  Scanning your codebase for API usage...\n'))
  const scannedServices = scanCodebase(cwd)
  const detectedNames = new Set(services.map(s => s.name))
  const newFromScan = scannedServices.filter(s => !detectedNames.has(s.name))

  if (newFromScan.length > 0) {
    console.log(chalk.bold(`  Found ${newFromScan.length} more services in your code:\n`))
    console.log(chalk.dim('  ┌──────────────────────────────────────────────────────────────┐'))
    for (const svc of newFromScan) {
      const catalogEntry = SERVICE_CATALOG.find(c => c.name === svc.name)
      const displayName = catalogEntry?.displayName ?? svc.name
      const files = svc.foundIn.slice(0, 3).join(', ')
      const more = svc.foundIn.length > 3 ? ` +${svc.foundIn.length - 3} more` : ''
      console.log(`  ${chalk.yellow('  ◆')}  ${displayName.padEnd(20)} ${chalk.dim(`found in: ${files}${more}`)}`)
    }
    console.log(chalk.dim('  └──────────────────────────────────────────────────────────────┘'))
    console.log()

    // Add scanned services to detected list for plan questions later
    for (const svc of newFromScan) {
      detectedNames.add(svc.name)
    }
  } else {
    console.log(chalk.dim('  No additional services found in codebase.\n'))
  }

  const keyChoice = await select({
    message: 'Do you have a burn0 API key? (get one free at burn0.dev)',
    choices: [
      { name: 'Yes — paste it', value: 'yes' },
      { name: 'Skip — use local mode for now', value: 'skip' },
    ],
  })

  let apiKey: string | undefined
  if (keyChoice === 'yes') {
    apiKey = await input({ message: 'Paste your API key:' })
    writeApiKeyToEnv(cwd, apiKey)
    console.log(chalk.green('  ✓ Added BURN0_API_KEY to .env'))
  }

  // Collect all fixed-tier services from both package.json and code scan
  const serviceConfigs: { name: string; plan?: string; monthlyCost?: number }[] = []

  // Fixed-tier from package.json detection
  const detectedFixedTier = services.filter(s => !s.autopriced)
  // Fixed-tier from code scan
  const scannedFixedTier = newFromScan.filter(s => {
    const entry = SERVICE_CATALOG.find(c => c.name === s.name)
    return entry?.pricingType === 'fixed'
  })

  const allFixedTier = [
    ...detectedFixedTier.map(s => s.name),
    ...scannedFixedTier.map(s => s.name),
  ]

  for (const name of allFixedTier) {
    const catalogEntry = SERVICE_CATALOG.find(c => c.name === name)
    if (catalogEntry?.plans) {
      const plan = await select({
        message: `${catalogEntry.displayName} — which plan are you on?`,
        choices: [
          ...catalogEntry.plans.map(p => ({ name: p.name, value: p.value })),
          { name: "Skip — I'll set this up later", value: 'skip' },
        ],
      })
      if (plan !== 'skip') {
        const selected = catalogEntry.plans.find(p => p.value === plan)
        serviceConfigs.push({ name, plan, monthlyCost: selected?.monthly })
      }
    }
  }

  // Ask if they use other services not detected from package.json or code scan
  const additionalServices = SERVICE_CATALOG.filter(s => !detectedNames.has(s.name))

  const addMore = await confirm({
    message: 'Do you use any other paid APIs or services? (not detected from package.json)',
    default: false,
  })

  if (addMore) {
    // Group by category for cleaner display
    const llmChoices = additionalServices
      .filter(s => s.category === 'llm')
      .map(s => ({ name: `${s.displayName}`, value: s.name }))
    const apiChoices = additionalServices
      .filter(s => s.category === 'api')
      .map(s => ({ name: `${s.displayName}`, value: s.name }))
    const infraChoices = additionalServices
      .filter(s => s.category === 'infra')
      .map(s => ({ name: `${s.displayName}`, value: s.name }))

    const selected = await checkbox({
      message: 'Select all services you use (space to select, enter to confirm)',
      choices: [
        ...(llmChoices.length ? [{ name: chalk.bold.blue('── LLM Providers ──'), value: '__sep_llm', disabled: true as any }] : []),
        ...llmChoices,
        ...(apiChoices.length ? [{ name: chalk.bold.magenta('── API Services ──'), value: '__sep_api', disabled: true as any }] : []),
        ...apiChoices,
        ...(infraChoices.length ? [{ name: chalk.bold.yellow('── Infrastructure ──'), value: '__sep_infra', disabled: true as any }] : []),
        ...infraChoices,
      ],
    })

    // For each selected fixed-tier service, ask their plan
    for (const name of selected) {
      if (name.startsWith('__sep_')) continue
      const catalogEntry = SERVICE_CATALOG.find(c => c.name === name)
      if (!catalogEntry) continue

      if (catalogEntry.pricingType === 'fixed' && catalogEntry.plans) {
        const plan = await select({
          message: `${catalogEntry.displayName} — which plan are you on?`,
          choices: [
            ...catalogEntry.plans.map(p => ({ name: p.name, value: p.value })),
            { name: "Skip — I'll set this up later", value: 'skip' },
          ],
        })
        if (plan !== 'skip') {
          const selectedPlan = catalogEntry.plans.find(p => p.value === plan)
          serviceConfigs.push({ name, plan, monthlyCost: selectedPlan?.monthly })
        }
      } else {
        // Auto-priced service, just register it
        serviceConfigs.push({ name })
      }
    }
  }

  const pkgJsonPath = path.join(cwd, 'package.json')
  let defaultName = 'my-project'
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    if (pkg.name) defaultName = pkg.name
  } catch {}

  const projectName = await input({
    message: 'Project name? (used in dashboard)',
    default: defaultName,
  })

  writeConfig(cwd, {
    projectName,
    services: serviceConfigs.map(s => ({
      name: s.name,
      pricingModel: s.plan ? 'fixed-tier' as const : 'auto' as const,
      plan: s.plan,
      monthlyCost: s.monthlyCost,
    })),
  })

  ensureGitignore(cwd, '.burn0/')

  const gitignorePath = path.join(cwd, '.gitignore')
  let gitignoreContent = ''
  try { gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8') } catch {}
  if (!gitignoreContent.includes('.env')) {
    const addEnv = await confirm({ message: '.env is not in .gitignore. Add it?' })
    if (addEnv) ensureGitignore(cwd, '.env')
  }

  console.log('')
  console.log(chalk.green('  ✓ Config written to .burn0/config.json'))
  console.log(chalk.green('  ✓ Added .burn0/ to .gitignore'))
  console.log('')
  console.log(chalk.bold('  ┌──────────────────────────────────────────────┐'))
  console.log(chalk.bold('  │') + chalk.dim('  Next steps:                                ') + chalk.bold('│'))
  console.log(chalk.bold('  │                                              │'))
  console.log(chalk.bold('  │') + chalk.cyan("  1. Add to your app entry point:            ") + chalk.bold('│'))
  console.log(chalk.bold('  │') + chalk.white("     import 'burn0'                          ") + chalk.bold('│'))
  console.log(chalk.bold('  │                                              │'))
  console.log(chalk.bold('  │') + chalk.cyan('  2. Optional — track specific features:     ') + chalk.bold('│'))
  console.log(chalk.bold('  │') + chalk.white("     import { track } from 'burn0'           ") + chalk.bold('│'))
  console.log(chalk.bold('  │') + chalk.white("     track('feat', { userId }, async () => {})") + chalk.bold('│'))
  console.log(chalk.bold('  │                                              │'))
  console.log(chalk.bold('  │') + chalk.cyan('  3. Check your costs:                       ') + chalk.bold('│'))
  console.log(chalk.bold('  │') + chalk.white('     burn0 report                            ') + chalk.bold('│'))
  console.log(chalk.bold('  └──────────────────────────────────────────────┘'))
  console.log('')
}

function writeApiKeyToEnv(cwd: string, apiKey: string): void {
  const envPath = path.join(cwd, '.env')
  const examplePath = path.join(cwd, '.env.example')

  let envContent = ''
  try { envContent = fs.readFileSync(envPath, 'utf-8') } catch {}

  if (envContent.includes('BURN0_API_KEY=')) {
    envContent = envContent.replace(/BURN0_API_KEY=.*/, `BURN0_API_KEY=${apiKey}`)
  } else {
    envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}BURN0_API_KEY=${apiKey}\n`
  }
  fs.writeFileSync(envPath, envContent)

  let exampleContent = ''
  try { exampleContent = fs.readFileSync(examplePath, 'utf-8') } catch {}
  if (!exampleContent.includes('BURN0_API_KEY=')) {
    exampleContent += `${exampleContent && !exampleContent.endsWith('\n') ? '\n' : ''}BURN0_API_KEY=\n`
    fs.writeFileSync(examplePath, exampleContent)
  }
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
