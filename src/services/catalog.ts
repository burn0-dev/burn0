/**
 * Full catalog of services burn0 supports.
 * Used by `burn0 init` wizard to let developers manually add services
 * that aren't detected from package.json (e.g., raw fetch calls).
 */

export interface CatalogService {
  name: string
  displayName: string
  category: 'llm' | 'api' | 'infra'
  pricingType: 'auto' | 'fixed'
  plans?: { name: string; value: string; monthly?: number }[]
}

export const SERVICE_CATALOG: CatalogService[] = [
  // LLMs — all auto-priced
  { name: 'openai', displayName: 'OpenAI', category: 'llm', pricingType: 'auto' },
  { name: 'anthropic', displayName: 'Anthropic', category: 'llm', pricingType: 'auto' },
  { name: 'google-gemini', displayName: 'Google Gemini', category: 'llm', pricingType: 'auto' },
  { name: 'mistral', displayName: 'Mistral', category: 'llm', pricingType: 'auto' },
  { name: 'cohere', displayName: 'Cohere', category: 'llm', pricingType: 'auto' },
  { name: 'xai', displayName: 'xAI / Grok', category: 'llm', pricingType: 'auto' },
  { name: 'azure-openai', displayName: 'Azure OpenAI', category: 'llm', pricingType: 'auto' },
  { name: 'amazon-bedrock', displayName: 'Amazon Bedrock', category: 'llm', pricingType: 'auto' },
  { name: 'huggingface', displayName: 'Hugging Face Inference', category: 'llm', pricingType: 'auto' },
  { name: 'groq', displayName: 'Groq', category: 'llm', pricingType: 'auto' },
  { name: 'together-ai', displayName: 'Together AI', category: 'llm', pricingType: 'auto' },
  { name: 'perplexity', displayName: 'Perplexity', category: 'llm', pricingType: 'auto' },
  { name: 'fireworks-ai', displayName: 'Fireworks AI', category: 'llm', pricingType: 'auto' },
  { name: 'deepseek', displayName: 'DeepSeek', category: 'llm', pricingType: 'auto' },
  { name: 'replicate', displayName: 'Replicate', category: 'llm', pricingType: 'auto' },
  { name: 'ai21', displayName: 'AI21 Labs', category: 'llm', pricingType: 'auto' },

  // APIs — auto-priced (pay-per-use)
  { name: 'stripe', displayName: 'Stripe', category: 'api', pricingType: 'auto' },
  { name: 'paypal', displayName: 'PayPal', category: 'api', pricingType: 'auto' },
  { name: 'sendgrid', displayName: 'SendGrid', category: 'api', pricingType: 'auto' },
  { name: 'resend', displayName: 'Resend', category: 'api', pricingType: 'auto' },
  { name: 'postmark', displayName: 'Postmark', category: 'api', pricingType: 'auto' },
  { name: 'mailgun', displayName: 'Mailgun', category: 'api', pricingType: 'auto' },
  { name: 'aws-ses', displayName: 'AWS SES', category: 'api', pricingType: 'auto' },
  { name: 'twilio', displayName: 'Twilio', category: 'api', pricingType: 'auto' },
  { name: 'vonage', displayName: 'Vonage', category: 'api', pricingType: 'auto' },
  { name: 'auth0', displayName: 'Auth0', category: 'api', pricingType: 'auto' },
  { name: 'clerk', displayName: 'Clerk', category: 'api', pricingType: 'auto' },
  { name: 'algolia', displayName: 'Algolia', category: 'api', pricingType: 'auto' },
  { name: 'cloudinary', displayName: 'Cloudinary', category: 'api', pricingType: 'auto' },
  { name: 'aws-s3', displayName: 'AWS S3', category: 'api', pricingType: 'auto' },
  { name: 'cloudflare-r2', displayName: 'Cloudflare R2', category: 'api', pricingType: 'auto' },
  { name: 'uploadcare', displayName: 'Uploadcare', category: 'api', pricingType: 'auto' },
  { name: 'google-maps', displayName: 'Google Maps', category: 'api', pricingType: 'auto' },
  { name: 'mapbox', displayName: 'Mapbox', category: 'api', pricingType: 'auto' },
  { name: 'sentry', displayName: 'Sentry', category: 'api', pricingType: 'auto' },
  { name: 'datadog', displayName: 'DataDog', category: 'api', pricingType: 'auto' },
  { name: 'onesignal', displayName: 'OneSignal', category: 'api', pricingType: 'auto' },
  { name: 'segment', displayName: 'Segment', category: 'api', pricingType: 'auto' },
  { name: 'mixpanel', displayName: 'Mixpanel', category: 'api', pricingType: 'auto' },
  { name: 'github-api', displayName: 'GitHub API', category: 'api', pricingType: 'auto' },
  { name: 'slack-api', displayName: 'Slack API', category: 'api', pricingType: 'auto' },
  { name: 'discord-api', displayName: 'Discord API', category: 'api', pricingType: 'auto' },
  { name: 'plaid', displayName: 'Plaid', category: 'api', pricingType: 'auto' },

  // Infrastructure — fixed-tier (need plan info)
  {
    name: 'supabase', displayName: 'Supabase', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Free', value: 'free', monthly: 0 },
      { name: 'Pro — $25/mo', value: 'pro', monthly: 25 },
      { name: 'Team — $599/mo', value: 'team', monthly: 599 },
    ],
  },
  {
    name: 'planetscale', displayName: 'PlanetScale', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Scaler — $29/mo', value: 'scaler', monthly: 29 },
      { name: 'Scaler Pro — $39/mo', value: 'scaler_pro', monthly: 39 },
    ],
  },
  {
    name: 'mongodb-atlas', displayName: 'MongoDB Atlas', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Free (M0)', value: 'free', monthly: 0 },
      { name: 'Shared (M2) — $9/mo', value: 'shared_m2', monthly: 9 },
      { name: 'Shared (M5) — $25/mo', value: 'shared_m5', monthly: 25 },
      { name: 'Dedicated (M10) — $57/mo', value: 'dedicated_m10', monthly: 57 },
    ],
  },
  {
    name: 'upstash', displayName: 'Upstash Redis', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Free', value: 'free', monthly: 0 },
      { name: 'Pay-as-you-go (max $120/mo)', value: 'payg', monthly: 0 },
      { name: 'Pro — $280/mo', value: 'pro', monthly: 280 },
    ],
  },
  {
    name: 'neon', displayName: 'Neon Postgres', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Free', value: 'free', monthly: 0 },
      { name: 'Launch — $19/mo', value: 'launch', monthly: 19 },
      { name: 'Scale — $69/mo', value: 'scale', monthly: 69 },
    ],
  },
  {
    name: 'turso', displayName: 'Turso', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Starter (Free)', value: 'starter', monthly: 0 },
      { name: 'Scaler — $29/mo', value: 'scaler', monthly: 29 },
      { name: 'Pro — $99/mo', value: 'pro', monthly: 99 },
    ],
  },
  {
    name: 'firebase', displayName: 'Firebase / Firestore', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Spark (Free)', value: 'spark', monthly: 0 },
      { name: 'Blaze (Pay-as-you-go)', value: 'blaze', monthly: 0 },
    ],
  },
  {
    name: 'vercel', displayName: 'Vercel', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Hobby (Free)', value: 'hobby', monthly: 0 },
      { name: 'Pro — $20/mo', value: 'pro', monthly: 20 },
    ],
  },
  {
    name: 'netlify', displayName: 'Netlify', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Starter (Free)', value: 'starter', monthly: 0 },
      { name: 'Pro — $19/mo', value: 'pro', monthly: 19 },
    ],
  },
  {
    name: 'aws-lambda', displayName: 'AWS Lambda', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Pay-as-you-go', value: 'payg', monthly: 0 },
    ],
  },
  {
    name: 'pinecone', displayName: 'Pinecone', category: 'infra', pricingType: 'fixed',
    plans: [
      { name: 'Starter (Free)', value: 'starter', monthly: 0 },
      { name: 'Standard — $70/mo+', value: 'standard', monthly: 70 },
    ],
  },
]
