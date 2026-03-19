export interface Burn0Event {
  schema_version: number
  service: string
  endpoint: string
  model?: string
  tokens_in?: number
  tokens_out?: number
  status_code: number
  timestamp: string
  duration_ms: number
  estimated: boolean
  feature?: string
  metadata?: Record<string, string | number | boolean>
}

export type RuntimeMode =
  | 'dev-cloud'
  | 'dev-local'
  | 'prod-cloud'
  | 'prod-local'
  | 'test-disabled'
  | 'test-enabled'

export interface Burn0Config {
  projectName?: string
  services?: ServiceConfig[]
}

export interface ServiceConfig {
  name: string
  pricingModel: 'auto' | 'fixed-tier'
  plan?: string
  monthlyCost?: number
}

export interface Span {
  end: () => void
}

export const SCHEMA_VERSION = 1
