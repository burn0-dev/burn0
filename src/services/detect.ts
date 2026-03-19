import fs from 'node:fs'
import path from 'node:path'

export interface DetectedService {
  name: string
  package: string
  category: 'llm' | 'api'
  autopriced: boolean
}

const KNOWN_SDKS: Record<string, Omit<DetectedService, 'package'>> = {
  'openai': { name: 'openai', category: 'llm', autopriced: true },
  '@anthropic-ai/sdk': { name: 'anthropic', category: 'llm', autopriced: true },
  '@google/generative-ai': { name: 'google-gemini', category: 'llm', autopriced: true },
  '@mistralai/mistralai': { name: 'mistral', category: 'llm', autopriced: true },
  'cohere-ai': { name: 'cohere', category: 'llm', autopriced: true },
  'stripe': { name: 'stripe', category: 'api', autopriced: true },
  '@sendgrid/mail': { name: 'sendgrid', category: 'api', autopriced: true },
  'twilio': { name: 'twilio', category: 'api', autopriced: true },
  'resend': { name: 'resend', category: 'api', autopriced: true },
  '@supabase/supabase-js': { name: 'supabase', category: 'api', autopriced: false },
}

export function detectServices(projectRoot: string): DetectedService[] {
  const pkgPath = path.join(projectRoot, 'package.json')
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw)
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const found: DetectedService[] = []
    for (const [pkgName, info] of Object.entries(KNOWN_SDKS)) {
      if (pkgName in allDeps) {
        found.push({ ...info, package: pkgName })
      }
    }
    return found
  } catch {
    return []
  }
}
