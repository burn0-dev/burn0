import { HOSTS, MULTI_SERVICE_APEXES } from './hosts.js'

const TWO_LEVEL_TLDS = new Set(['co.uk', 'com.au', 'co.jp', 'co.in', 'com.br', 'co.nz'])

export function detectEntity(hostname: string): { entity: string; entityClass: 'llm' | 'general'; provider: string | null } {
  for (const rule of HOSTS) {
    if (rule.match(hostname)) return { entity: rule.entity, entityClass: rule.entityClass, provider: rule.provider }
  }
  return { entity: registrableDomain(hostname), entityClass: 'general', provider: null }
}

export interface ResolvedHost {
  vendor: string
  service: string
  entityClass: 'llm' | 'general'
  provider: string | null
}

/** Vendor/service pair for the usage tree. `vendor` groups services that share
 *  one apex domain (AWS → S3, Bedrock, SES); for everything else vendor === service.
 *  Resolved at read time so adding a rule re-buckets existing history. */
export function resolveHost(hostname: string): ResolvedHost {
  // Explicit rules win — they carry `provider`, which pricing depends on.
  for (const rule of HOSTS) {
    if (rule.match(hostname)) {
      return {
        vendor: rule.vendor ?? rule.entity,
        service: rule.entity,
        entityClass: rule.entityClass,
        provider: rule.provider,
      }
    }
  }
  // Multi-service apex with no rule: the subdomain names the service.
  for (const { apex, vendor } of MULTI_SERVICE_APEXES) {
    if (hostname === apex || hostname.endsWith('.' + apex)) {
      const label = hostname.split('.')[0]
      const service = label && hostname !== apex ? label : vendor
      return { vendor, service, entityClass: 'general', provider: null }
    }
  }
  const domain = registrableDomain(hostname)
  return { vendor: domain, service: domain, entityClass: 'general', provider: null }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

function registrableDomain(hostname: string): string {
  // IP addresses (and bracketed IPv6) have no registrable domain — keep whole
  if (IPV4.test(hostname) || hostname.includes(':') || hostname.startsWith('[')) return hostname
  const parts = hostname.split('.')
  if (parts.length <= 2) return hostname
  const lastTwo = parts.slice(-2).join('.')
  const take = TWO_LEVEL_TLDS.has(lastTwo) ? 3 : 2
  return parts.slice(-take).join('.')
}

const NUMERIC = /^\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX = /^[0-9a-f]{16,}$/i

export function normalizeEndpoint(pathname: string): string {
  const segments = pathname.split('/')
  const out = segments.map((seg) => {
    if (seg === '') return seg
    if (NUMERIC.test(seg) || UUID.test(seg) || LONG_HEX.test(seg)) return ':id'
    return seg
  })
  return out.join('') === '' ? '/' : out.join('/')
}
