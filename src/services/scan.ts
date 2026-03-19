/**
 * Scans source files for API hostnames and env var patterns
 * to detect services the developer uses via raw fetch/http calls.
 */
import fs from 'node:fs'
import path from 'node:path'

// Hostnames to scan for (from the service map)
const HOSTNAME_PATTERNS: Record<string, string> = {
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
  'api.stripe.com': 'stripe',
  'api.paypal.com': 'paypal',
  'api.sendgrid.com': 'sendgrid',
  'api.resend.com': 'resend',
  'api.postmarkapp.com': 'postmark',
  'api.mailgun.net': 'mailgun',
  'email.us-east-1.amazonaws.com': 'aws-ses',
  'api.twilio.com': 'twilio',
  'api.vonage.com': 'vonage',
  'auth0.com': 'auth0',
  'api.clerk.com': 'clerk',
  'api.algolia.com': 'algolia',
  'api.cloudinary.com': 'cloudinary',
  's3.amazonaws.com': 'aws-s3',
  'r2.cloudflarestorage.com': 'cloudflare-r2',
  'upload.uploadcare.com': 'uploadcare',
  'maps.googleapis.com': 'google-maps',
  'api.mapbox.com': 'mapbox',
  'sentry.io': 'sentry',
  'api.datadoghq.com': 'datadog',
  'onesignal.com': 'onesignal',
  'api.segment.io': 'segment',
  'api.mixpanel.com': 'mixpanel',
  'api.github.com': 'github-api',
  'slack.com': 'slack-api',
  'discord.com': 'discord-api',
  'api.plaid.com': 'plaid',
  'api.pinecone.io': 'pinecone',
  '.supabase.co': 'supabase',
  'planetscale': 'planetscale',
  'cloud.mongodb.com': 'mongodb-atlas',
  'upstash.io': 'upstash',
  'neon.tech': 'neon',
  'turso.tech': 'turso',
  'firestore.googleapis.com': 'firebase',
  'firebase.google.com': 'firebase',
  'lambda.amazonaws.com': 'aws-lambda',
}

// Env var patterns that hint at service usage
const ENV_PATTERNS: Record<string, string> = {
  'OPENAI_API_KEY': 'openai',
  'ANTHROPIC_API_KEY': 'anthropic',
  'GEMINI_API_KEY': 'google-gemini',
  'MISTRAL_API_KEY': 'mistral',
  'COHERE_API_KEY': 'cohere',
  'GROQ_API_KEY': 'groq',
  'TOGETHER_API_KEY': 'together-ai',
  'PERPLEXITY_API_KEY': 'perplexity',
  'FIREWORKS_API_KEY': 'fireworks-ai',
  'DEEPSEEK_API_KEY': 'deepseek',
  'REPLICATE_API_TOKEN': 'replicate',
  'STRIPE_SECRET_KEY': 'stripe',
  'STRIPE_API_KEY': 'stripe',
  'SENDGRID_API_KEY': 'sendgrid',
  'RESEND_API_KEY': 'resend',
  'POSTMARK_API_KEY': 'postmark',
  'MAILGUN_API_KEY': 'mailgun',
  'TWILIO_ACCOUNT_SID': 'twilio',
  'TWILIO_AUTH_TOKEN': 'twilio',
  'AUTH0_SECRET': 'auth0',
  'AUTH0_CLIENT_ID': 'auth0',
  'CLERK_SECRET_KEY': 'clerk',
  'ALGOLIA_API_KEY': 'algolia',
  'CLOUDINARY_URL': 'cloudinary',
  'AWS_ACCESS_KEY_ID': 'aws-s3',
  'SUPABASE_URL': 'supabase',
  'SUPABASE_KEY': 'supabase',
  'SUPABASE_ANON_KEY': 'supabase',
  'DATABASE_URL': 'planetscale', // common for PlanetScale
  'MONGODB_URI': 'mongodb-atlas',
  'MONGO_URI': 'mongodb-atlas',
  'UPSTASH_REDIS_REST_URL': 'upstash',
  'PINECONE_API_KEY': 'pinecone',
  'PLAID_CLIENT_ID': 'plaid',
  'PLAID_SECRET': 'plaid',
  'FIREBASE_PROJECT_ID': 'firebase',
  'GOOGLE_APPLICATION_CREDENTIALS': 'firebase',
  'SENTRY_DSN': 'sentry',
  'DD_API_KEY': 'datadog',
  'MIXPANEL_TOKEN': 'mixpanel',
  'SEGMENT_WRITE_KEY': 'segment',
}

export interface ScannedService {
  name: string
  foundIn: string[] // file paths where it was detected
  source: 'code' | 'env' // how it was detected
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const IGNORE_DIRS = ['node_modules', '.next', '.nuxt', 'dist', 'build', '.git', '.burn0', 'coverage']

function getSourceFiles(dir: string, maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth) return []
  const files: string[] = []

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORE_DIRS.includes(entry.name)) continue
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        files.push(...getSourceFiles(fullPath, maxDepth, depth + 1))
      } else if (SOURCE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
        files.push(fullPath)
      }
    }
  } catch {}

  return files
}

export function scanCodebase(projectRoot: string): ScannedService[] {
  const found: Map<string, Set<string>> = new Map()

  // Scan source files for hostnames
  const sourceFiles = getSourceFiles(projectRoot)
  for (const filePath of sourceFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const relativePath = path.relative(projectRoot, filePath)

      for (const [hostname, service] of Object.entries(HOSTNAME_PATTERNS)) {
        if (content.includes(hostname)) {
          if (!found.has(service)) found.set(service, new Set())
          found.get(service)!.add(relativePath)
        }
      }
    } catch {}
  }

  // Scan .env files for env var patterns
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production']
  for (const envFile of envFiles) {
    const envPath = path.join(projectRoot, envFile)
    try {
      const content = fs.readFileSync(envPath, 'utf-8')
      for (const [envVar, service] of Object.entries(ENV_PATTERNS)) {
        if (content.includes(envVar)) {
          if (!found.has(service)) found.set(service, new Set())
          found.get(service)!.add(envFile)
        }
      }
    } catch {}
  }

  // Convert to array
  const results: ScannedService[] = []
  for (const [name, files] of found) {
    const fileList = Array.from(files)
    const source = fileList.some(f => f.startsWith('.env')) ? 'env' : 'code'
    results.push({ name, foundIn: fileList, source })
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}
