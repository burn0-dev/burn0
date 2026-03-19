import { input, select, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { detectServices } from '../services/detect'
import { writeConfig } from '../config/store'
import type { ServiceConfig } from '../types'

export async function runInit(): Promise<void> {
  const cwd = process.cwd()
  console.log(chalk.dim('\n🔍 Scanning your project...\n'))

  const services = detectServices(cwd)

  if (services.length === 0) {
    console.log(chalk.yellow('  No known API services found in package.json.'))
    console.log(chalk.dim('  burn0 will still track any outgoing HTTP calls.\n'))
  } else {
    console.log(`  Found ${services.length} services in package.json:`)
    for (const svc of services) {
      const label = svc.autopriced ? chalk.green('✓') : chalk.yellow('◆')
      const category = svc.category === 'llm' ? 'LLM (auto-priced)' :
                       svc.autopriced ? 'API (auto-priced)' : 'API (plan needed)'
      console.log(`    ${label} ${svc.package.padEnd(25)} → ${category}`)
    }
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

  console.log(chalk.green('\n  ✓ Config written to .burn0/config.json'))
  console.log(chalk.green('  ✓ Added .burn0/ to .gitignore'))
  console.log(chalk.dim("\n  Add this to your app entry point:\n"))
  console.log(chalk.cyan("    import 'burn0'\n"))
  console.log(chalk.dim('  Want per-feature tracking? Use:\n'))
  console.log(chalk.cyan("    import { track } from 'burn0'"))
  console.log(chalk.cyan("    track('feature', { userId }, async () => { ... })\n"))
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
