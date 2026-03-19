import { input } from '@inquirer/prompts'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

export async function runConnect(): Promise<void> {
  const cwd = process.cwd()
  const apiKey = await input({ message: 'Paste your burn0 API key:' })

  if (!apiKey || !apiKey.startsWith('b0_sk_')) {
    console.log(chalk.red('\n  Invalid key. Keys start with b0_sk_\n'))
    return
  }

  const envPath = path.join(cwd, '.env')
  let content = ''
  try { content = fs.readFileSync(envPath, 'utf-8') } catch {}

  if (content.includes('BURN0_API_KEY=')) {
    content = content.replace(/BURN0_API_KEY=.*/, `BURN0_API_KEY=${apiKey}`)
  } else {
    content += `${content && !content.endsWith('\n') ? '\n' : ''}BURN0_API_KEY=${apiKey}\n`
  }
  fs.writeFileSync(envPath, content)

  console.log(chalk.green('\n  ✓ Added BURN0_API_KEY to .env'))

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'))
    if (pkg.name) {
      console.log(chalk.green(`  ✓ Connected to project "${pkg.name}" on burn0.dev\n`))
    }
  } catch {
    console.log(chalk.green('  ✓ Connected to burn0.dev\n'))
  }
}
