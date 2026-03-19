const BUILT_IN_MAP: Record<string, string> = {
  // LLMs
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google-gemini',
  'api.mistral.ai': 'mistral',
  'api.cohere.com': 'cohere',
  'api.groq.com': 'groq',
  'api.together.xyz': 'together-ai',
  'api.perplexity.ai': 'perplexity',
  'api.fireworks.ai': 'fireworks-ai',
  'api.deepseek.com': 'deepseek',
  'api.replicate.com': 'replicate',
  'api.ai21.com': 'ai21',
  // APIs
  'api.stripe.com': 'stripe',
  'api.paypal.com': 'paypal',
  'api.sendgrid.com': 'sendgrid',
  'api.resend.com': 'resend',
  'api.postmarkapp.com': 'postmark',
  'api.mailgun.net': 'mailgun',
  'api.twilio.com': 'twilio',
  'api.vonage.com': 'vonage',
  'api.clerk.com': 'clerk',
  'api.cloudinary.com': 'cloudinary',
  'upload.uploadcare.com': 'uploadcare',
  'maps.googleapis.com': 'google-maps',
  'api.mapbox.com': 'mapbox',
  'api.segment.io': 'segment',
  'api.mixpanel.com': 'mixpanel',
  'api.github.com': 'github-api',
  'api.plaid.com': 'plaid',
  'api.pinecone.io': 'pinecone',
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
