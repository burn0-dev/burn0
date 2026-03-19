import type { RuntimeMode } from '../types'

export function getApiKey(): string | undefined {
  const key = process.env.BURN0_API_KEY
  return key && key.length > 0 ? key : undefined
}

export function detectMode(opts: { isTTY: boolean; apiKey: string | undefined }): RuntimeMode {
  const isTest = process.env.NODE_ENV === 'test'
  if (isTest) {
    return process.env.BURN0_ENABLE_TEST === '1' ? 'test-enabled' : 'test-disabled'
  }
  if (opts.apiKey) {
    return opts.isTTY ? 'dev-cloud' : 'prod-cloud'
  }
  return opts.isTTY ? 'dev-local' : 'prod-local'
}

export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY)
}
