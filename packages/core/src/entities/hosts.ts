export interface HostRule {
  match: (hostname: string) => boolean
  entity: string
  entityClass: 'llm' | 'general'
  provider: string | null
  /** Parent vendor when one apex domain hosts many billable services (AWS, Google).
   *  Defaults to `entity` — most vendors are their own parent. */
  vendor?: string
}

const eq = (h: string) => (x: string) => x === h
const suffix = (s: string) => (x: string) => x === s || x.endsWith('.' + s)
/** First DNS label of a host under `apex`, e.g. s3.us-east-1.amazonaws.com → 's3' */
const sub = (apex: string, label: string) => (x: string) =>
  (x === apex || x.endsWith('.' + apex)) && x.split('.')[0] === label

/** Apex domains where one vendor hosts many separately-billed services and the
 *  first DNS label names the service. Deriving beats enumerating: AWS ships new
 *  services constantly and every one of them works here for free. */
export const MULTI_SERVICE_APEXES: { apex: string; vendor: string }[] = [
  { apex: 'amazonaws.com', vendor: 'AWS' },
  { apex: 'googleapis.com', vendor: 'Google APIs' },
]

export const HOSTS: HostRule[] = [
  // LLM providers
  { match: eq('api.openai.com'), entity: 'OpenAI', entityClass: 'llm', provider: 'openai' },
  { match: eq('api.anthropic.com'), entity: 'Anthropic', entityClass: 'llm', provider: 'anthropic' },
  { match: eq('generativelanguage.googleapis.com'), entity: 'Gemini', entityClass: 'llm', provider: 'gemini' },
  { match: eq('api.mistral.ai'), entity: 'Mistral', entityClass: 'llm', provider: 'mistral' },
  { match: eq('api.groq.com'), entity: 'Groq', entityClass: 'llm', provider: 'groq' },
  { match: eq('api.cohere.com'), entity: 'Cohere', entityClass: 'llm', provider: 'cohere' },
  { match: eq('openrouter.ai'), entity: 'OpenRouter', entityClass: 'llm', provider: 'openrouter' },
  { match: eq('api.together.xyz'), entity: 'Together', entityClass: 'llm', provider: 'together_ai' },
  { match: eq('api.fireworks.ai'), entity: 'Fireworks', entityClass: 'llm', provider: 'fireworks_ai' },
  { match: eq('api.deepseek.com'), entity: 'DeepSeek', entityClass: 'llm', provider: 'deepseek' },
  { match: eq('api.x.ai'), entity: 'xAI', entityClass: 'llm', provider: 'xai' },
  { match: eq('api.perplexity.ai'), entity: 'Perplexity', entityClass: 'llm', provider: 'perplexity' },
  // Multi-service apexes: the service name is DERIVED from the subdomain
  // (see MULTI_SERVICE_APEXES below), not listed here. AWS alone has ~200
  // services; enumerating them is a table that is stale the day it is written.
  //
  // Overrides exist below for one functional reason only: LLM hosts need a
  // `provider`, without which cost resolves on the bare model name and can pick
  // up another vendor's rate. A prettier label is not a reason to add a row.
  { match: sub('amazonaws.com', 'bedrock-runtime'), entity: 'Bedrock', vendor: 'AWS', entityClass: 'llm', provider: 'bedrock' },
  { match: sub('amazonaws.com', 'bedrock'), entity: 'Bedrock', vendor: 'AWS', entityClass: 'llm', provider: 'bedrock' },
  { match: sub('googleapis.com', 'aiplatform'), entity: 'Vertex AI', vendor: 'Google APIs', entityClass: 'llm', provider: 'vertex_ai' },

  // General services
  { match: suffix('supabase.co'), entity: 'Supabase', entityClass: 'general', provider: null },
  { match: suffix('stripe.com'), entity: 'Stripe', entityClass: 'general', provider: null },
  { match: suffix('firebaseio.com'), entity: 'Firebase', entityClass: 'general', provider: null },
  // NOTE: no blanket googleapis.com / amazonaws.com rules — they would match
  // before MULTI_SERVICE_APEXES and collapse every service into one row.
  { match: suffix('github.com'), entity: 'GitHub', entityClass: 'general', provider: null },
  { match: suffix('api.github.com'), entity: 'GitHub', entityClass: 'general', provider: null },
  { match: suffix('resend.com'), entity: 'Resend', entityClass: 'general', provider: null },
  { match: suffix('twilio.com'), entity: 'Twilio', entityClass: 'general', provider: null },
  { match: suffix('vercel.com'), entity: 'Vercel', entityClass: 'general', provider: null },
  { match: suffix('sentry.io'), entity: 'Sentry', entityClass: 'general', provider: null },
  { match: suffix('algolia.net'), entity: 'Algolia', entityClass: 'general', provider: null },
  { match: suffix('cloudinary.com'), entity: 'Cloudinary', entityClass: 'general', provider: null },
  { match: suffix('sendgrid.com'), entity: 'SendGrid', entityClass: 'general', provider: null },
]
