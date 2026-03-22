import { input, select } from '@inquirer/prompts'
import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function openBrowser(url: string): boolean {
  try {
    const platform = process.platform
    if (platform === 'darwin') execFileSync('open', [url])
    else if (platform === 'win32') execFileSync('cmd', ['/c', 'start', url])
    else execFileSync('xdg-open', [url])
    return true
  } catch {
    return false
  }
}

export async function promptApiKey(cwd: string): Promise<string | undefined> {
  const choice = await select({
    message: 'API key?',
    choices: [
      { name: 'Paste key', value: 'paste' },
      { name: 'Get one free → burn0.dev/api', value: 'get' },
      { name: 'Skip — local mode', value: 'skip' },
    ],
  })

  if (choice === 'skip') return undefined

  if (choice === 'get') {
    const opened = openBrowser('https://burn0.dev/api')
    if (!opened) {
      console.log(chalk.dim('\n  Visit burn0.dev/api to get your free API key\n'))
    } else {
      console.log(chalk.dim('\n  Opening burn0.dev/api in your browser...\n'))
    }
  }

  while (true) {
    const apiKey = await input({ message: 'Paste your API key:' })

    if (!apiKey || !apiKey.startsWith('b0_sk_')) {
      console.log(chalk.red('\n  Invalid key. Keys start with b0_sk_'))
      const retry = await select({
        message: 'What would you like to do?',
        choices: [
          { name: 'Try again', value: 'retry' },
          { name: 'Skip — local mode', value: 'skip' },
        ],
      })
      if (retry === 'skip') return undefined
      continue
    }

    writeApiKeyToEnv(cwd, apiKey)
    console.log(chalk.green('  ✓ Added BURN0_API_KEY to .env'))
    return apiKey
  }
}

export function writeApiKeyToEnv(cwd: string, apiKey: string): void {
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
