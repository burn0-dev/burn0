import { promptApiKey } from './api-key'
import { ensureGitignore } from './init'

export async function runConnect(): Promise<void> {
  const cwd = process.cwd()
  const key = await promptApiKey(cwd)
  if (key) {
    ensureGitignore(cwd, '.env')
    ensureGitignore(cwd, '.burn0/')
  }
}
