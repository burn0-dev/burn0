import { input, select, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { detectServices } from '../services/detect'
import { writeConfig } from '../config/store'
import type { ServiceConfig } from '../types'

export async function runInit(): Promise<void> {
  const cwd = process.cwd()

  const o = chalk.hex('#FA5D19')
  const banner = `
  ${'bbbb'}
  ${'b:::b'}                                            ${o('0000')}
  ${'b:::b'}                                          ${o('00::::00')}
  ${' b:::bbbb'}    ${'uu:::uu'} ${'rr::::rr'}   ${'nn:::nn'}    ${o('0::0  0::0')}
  ${' b:::::::b'}   ${'u::::u'}  ${'r::::::r'}   ${'n:::::nn'}   ${o('0::0  0::0')}
  ${' b:::bb::b'}   ${'u::::u'}  ${'rr:::r'}     ${'n::n::n'}   ${o('0::0  0::0')}
  ${' b:::b b::b'}  ${'u::::u'}   ${'r:::r'}     ${'n::n n::n'}  ${o('0::0  0::0')}
  ${' b:::bb:::b'}  ${'u:::::uu'} ${'r:::r'}     ${'n::n n::n'}  ${o('0::0  0::0')}
  ${' b::::::::b'}  ${'u::::::u'} ${'r:::r'}     ${'n::n n::n'}  ${o('00::::00')}
  ${' bbbbbbbb'}     ${'uuuuuu'}  ${'rrrrr'}     ${'nnnn nnnn'}    ${o('0000')}
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

  const fixedTierServices = services.filter(s => !s.autopriced)
  const serviceConfigs: { name: string; plan?: string }[] = []

  for (const svc of fixedTierServices) {
    const plan = await select({
      message: `${svc.name} — how are you billed?`,
      choices: [
        { name: 'Free tier', value: 'free' },
        { name: 'Pay-as-you-go', value: 'payg' },
        { name: 'Fixed plan (configure in dashboard)', value: 'fixed' },
        { name: "Skip — I'll set this up later", value: 'skip' },
      ],
    })
    if (plan !== 'skip') {
      serviceConfigs.push({ name: svc.name, plan })
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
      pricingModel: s.plan === 'fixed' ? 'fixed-tier' as const : 'auto' as const,
      plan: s.plan,
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
