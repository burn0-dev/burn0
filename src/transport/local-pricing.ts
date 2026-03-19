/**
 * Lightweight local pricing for terminal display only.
 * Not the source of truth — the backend pricing registry is authoritative.
 * This just gives developers a quick cost estimate in their terminal.
 */

// LLM pricing: per million tokens [input, output]
const LLM_PRICES: Record<string, Record<string, [number, number]>> = {
  openai: {
    'gpt-5.4': [2.50, 15.00],
    'gpt-5.4-mini': [0.75, 4.50],
    'gpt-5.4-nano': [0.20, 1.25],
    'gpt-4o': [2.50, 10.00],
    'gpt-4o-mini': [0.15, 0.60],
    'gpt-4-turbo': [10.00, 30.00],
    'o1': [15.00, 60.00],
    'o3': [10.00, 40.00],
    'o3-mini': [1.10, 4.40],
  },
  anthropic: {
    'claude-opus-4-6': [5.00, 25.00],
    'claude-sonnet-4-6': [3.00, 15.00],
    'claude-haiku-4-5': [1.00, 5.00],
    'claude-3-5-sonnet': [3.00, 15.00],
    'claude-3-5-haiku': [0.80, 4.00],
  },
  'google-gemini': {
    'gemini-2.5-pro': [1.25, 10.00],
    'gemini-2.5-flash': [0.15, 0.60],
    'gemini-2.0-flash': [0.10, 0.40],
    'gemini-1.5-pro': [1.25, 5.00],
    'gemini-1.5-flash': [0.075, 0.30],
  },
  groq: {
    'llama-4-scout': [0.11, 0.34],
    'llama-4-maverick': [0.20, 0.60],
    'llama-3.3-70b': [0.59, 0.79],
    'qwen3-32b': [0.29, 0.59],
  },
  perplexity: {
    'sonar-pro': [3.00, 15.00],
    'sonar': [1.00, 1.00],
  },
  deepseek: {
    'deepseek-chat': [0.27, 1.10],
    'deepseek-reasoner': [0.55, 2.19],
  },
  mistral: {
    'mistral-large': [2.00, 6.00],
    'mistral-small': [0.20, 0.60],
  },
}

// API pricing: flat cost per request
const API_PRICES: Record<string, number> = {
  stripe: 0.30,
  sendgrid: 0.001,
  resend: 0.0009,
  postmark: 0.001,
  mailgun: 0.0008,
  'aws-ses': 0.0001,
  twilio: 0.0079,
  vonage: 0.0068,
  algolia: 0.000001,
  'google-maps': 0.005,
}

export function estimateLocalCost(event: {
  service: string
  model?: string
  tokens_in?: number
  tokens_out?: number
}): number | null {
  // Try LLM pricing
  const llmService = LLM_PRICES[event.service]
  if (llmService && event.model && event.tokens_in !== undefined && event.tokens_out !== undefined) {
    // Try exact match, then prefix match
    let prices = llmService[event.model]
    if (!prices) {
      const match = Object.keys(llmService).find(m => event.model!.startsWith(m))
      if (match) prices = llmService[match]
    }
    if (prices) {
      const inputCost = (event.tokens_in / 1_000_000) * prices[0]
      const outputCost = (event.tokens_out / 1_000_000) * prices[1]
      return inputCost + outputCost
    }
  }

  // Try API pricing
  const apiPrice = API_PRICES[event.service]
  if (apiPrice !== undefined) {
    return apiPrice
  }

  return null
}
