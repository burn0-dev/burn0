import { describe, it, expect } from 'vitest'
import { resolveHost } from '../src/entities/index.js'

describe('resolveHost', () => {
  it('splits the AWS apex into per-service rows instead of one merged row', () => {
    // service names come from the subdomain, so they are lowercase as the host
    // writes them — 'SES' would need a hardcoded row and buys nothing (§7)
    expect(resolveHost('s3.us-east-1.amazonaws.com')).toMatchObject({ vendor: 'AWS', service: 's3' })
    expect(resolveHost('email.us-east-1.amazonaws.com')).toMatchObject({ vendor: 'AWS', service: 'email' })
    // Bedrock keeps an explicit rule because `provider` drives pricing
    expect(resolveHost('bedrock-runtime.us-east-1.amazonaws.com')).toMatchObject({ vendor: 'AWS', service: 'Bedrock' })
  })

  it('marks Bedrock as an llm host so its cost is priced', () => {
    expect(resolveHost('bedrock-runtime.eu-west-1.amazonaws.com')).toEqual({
      vendor: 'AWS', service: 'Bedrock', entityClass: 'llm', provider: 'bedrock',
    })
  })

  it('uses the same name for vendor and service when a vendor has one service', () => {
    expect(resolveHost('api.resend.com')).toEqual({
      vendor: 'Resend', service: 'Resend', entityClass: 'general', provider: null,
    })
    expect(resolveHost('api.openai.com')).toEqual({
      vendor: 'OpenAI', service: 'OpenAI', entityClass: 'llm', provider: 'openai',
    })
  })

  it('falls back to the registrable domain for unknown hosts', () => {
    expect(resolveHost('api.unheard-of.io')).toEqual({
      vendor: 'unheard-of.io', service: 'unheard-of.io', entityClass: 'general', provider: null,
    })
  })

  it('does not let an unmatched amazonaws subdomain claim a sibling service', () => {
    // cloudfront is not in the rule table — must not be mistaken for S3
    expect(resolveHost('cloudfront.amazonaws.com').service).not.toBe('S3')
  })

  it('derives the service from the subdomain for apexes with no rule', () => {
    // none of these are in any table — AWS has ~200 services and listing them
    // would go stale immediately. The subdomain already names the service.
    expect(resolveHost('kinesis.us-east-1.amazonaws.com')).toMatchObject({ vendor: 'AWS', service: 'kinesis' })
    expect(resolveHost('athena.eu-west-2.amazonaws.com')).toMatchObject({ vendor: 'AWS', service: 'athena' })
    expect(resolveHost('secretsmanager.ap-south-1.amazonaws.com')).toMatchObject({ vendor: 'AWS', service: 'secretsmanager' })
  })

  it('derives Google API services from the subdomain too', () => {
    expect(resolveHost('maps.googleapis.com')).toMatchObject({ vendor: 'Google APIs', service: 'maps' })
    expect(resolveHost('storage.googleapis.com')).toMatchObject({ vendor: 'Google APIs', service: 'storage' })
  })

  it('still names LLM services explicitly, because provider drives pricing', () => {
    // the one reason an override earns its place: without `provider`, cost is
    // looked up on the bare model name and can resolve to the wrong vendor's rate
    expect(resolveHost('bedrock-runtime.us-east-1.amazonaws.com')).toEqual({
      vendor: 'AWS', service: 'Bedrock', entityClass: 'llm', provider: 'bedrock',
    })
  })
})
