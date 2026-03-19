const BUILT_IN_MAP: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google-gemini',
  'api.mistral.ai': 'mistral',
  'api.cohere.com': 'cohere',
  'api.stripe.com': 'stripe',
  'api.sendgrid.com': 'sendgrid',
  'api.twilio.com': 'twilio',
  'api.resend.com': 'resend',
}

const IGNORED_PATTERNS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']

let serviceMap: Record<string, string> = { ...BUILT_IN_MAP }

export function identifyService(hostname: string): string | null {
  if (IGNORED_PATTERNS.includes(hostname) || hostname.startsWith('localhost:')) {
    return null
  }
  return serviceMap[hostname] ?? `unknown:${hostname}`
}

export function mergeServiceMap(remote: Record<string, string>): void {
  serviceMap = { ...serviceMap, ...remote }
}

export function resetServiceMap(): void {
  serviceMap = { ...BUILT_IN_MAP }
}
