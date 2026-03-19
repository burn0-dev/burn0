let patched = false

export function canPatch(): boolean {
  return !patched
}

export function markPatched(): void {
  patched = true
}

export function resetGuard(): void {
  patched = false
}

const KNOWN_SDK_MODULES = [
  'openai', '@anthropic-ai/sdk', '@google/generative-ai',
  '@mistralai/mistralai', 'cohere-ai', 'stripe',
  '@sendgrid/mail', 'twilio', 'resend', '@supabase/supabase-js',
]

export function checkImportOrder(): string[] {
  const preloaded: string[] = []
  if (typeof require !== 'undefined' && require.cache) {
    for (const sdk of KNOWN_SDK_MODULES) {
      if (Object.keys(require.cache).some(k => k.includes(`/node_modules/${sdk}/`))) {
        preloaded.push(sdk)
      }
    }
  }
  return preloaded
}
