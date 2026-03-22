import { promptApiKey } from './api-key'

export async function runConnect(): Promise<void> {
  await promptApiKey(process.cwd())
}
