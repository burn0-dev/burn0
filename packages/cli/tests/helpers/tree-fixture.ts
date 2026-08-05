import type { TraceTreeNode } from '@burn0/core'

/** The spec §2.6 reference trace, built as `traceTree` would return it: a
 *  DFS-flattened `nodes` array whose first element is the root. Pure data —
 *  no database, no clock — so the layout engine can be tested exactly.
 *
 *  Shape: root + 12 same-host discovery GETs (the fold wall) + 7
 *  `claude-sonnet-5` turns interleaved with 7 tool calls (13 SAP children
 *  between them; one tool errors with a 400 child, one never resolves).
 *  Durations sum to a 48.3s root with turn #3 at 8.4s (17.4% — the one row
 *  above the 15% "normal" line). */

export const T0 = 1_770_000_000_000
export const SAP_HOST = 'my-tenant.s4hanacloud.sap.com'
export const SAP_ENTITY = 'sap.com'
export const LLM_HOST = 'api.anthropic.com'
export const SAP_PREFIX = '/s4hanacloud/sap/opu/odata/sap/'
export const ROOT_LABEL = 'POST /api/conversations/:id/chat'
export const MODEL = 'claude-sonnet-5'

const BLANK = {
  endedAt: null,
  durationMs: null,
  status: null,
  costUsd: null,
  pricedCalls: 0,
  tokensIn: null,
  tokensOut: null,
  tokensCached: null,
  tokensCacheWrite: null,
  tokenCalls: 0,
  reqBytes: null,
  resBytes: null,
  calls: 1,
  llm: false,
  incomplete: false,
  hostname: null,
  model: null,
  method: null,
  requestId: null,
  expiredCalls: 0,
  toolStatus: null,
  attribution: null,
} satisfies Omit<TraceTreeNode, 'type' | 'id' | 'depth' | 'label' | 'startedAt'>

export function apiReq(o: {
  id: number; depth: number; at: number; ms: number; endpoint: string
  method?: string; status?: number | null; host?: string
}): TraceTreeNode {
  const method = o.method ?? 'GET'
  return {
    ...BLANK,
    type: 'request',
    id: o.id,
    depth: o.depth,
    label: `${method} ${o.endpoint}`,
    startedAt: o.at,
    endedAt: o.at + o.ms,
    durationMs: o.ms,
    status: o.status === undefined ? 200 : o.status,
    hostname: o.host ?? SAP_HOST,
    method,
    requestId: o.id,
    reqBytes: 512,
    resBytes: 4096,
  }
}

export function llmReq(o: {
  id: number; depth: number; at: number; ms: number
  tin?: number | null; cached?: number | null; tout?: number | null
  cost?: number | null; status?: number | null; model?: string | null
}): TraceTreeNode {
  const tin = o.tin === undefined ? 1000 : o.tin
  const tout = o.tout === undefined ? 100 : o.tout
  return {
    ...BLANK,
    type: 'request',
    id: o.id,
    depth: o.depth,
    label: 'POST /v1/messages',
    startedAt: o.at,
    endedAt: o.at + o.ms,
    durationMs: o.ms,
    status: o.status === undefined ? 200 : o.status,
    costUsd: o.cost === undefined ? 0.01 : o.cost,
    pricedCalls: (o.cost === undefined ? 0.01 : o.cost) != null ? 1 : 0,
    tokensIn: tin,
    tokensOut: tout,
    tokensCached: o.cached === undefined ? null : o.cached,
    tokenCalls: tin != null || tout != null ? 1 : 0,
    llm: true,
    hostname: LLM_HOST,
    model: o.model === undefined ? MODEL : o.model,
    method: 'POST',
    requestId: o.id,
    reqBytes: 48_000,
    resBytes: 2_400,
  }
}

/** A tool node rolls its subtree up the way `traceTree` does: sums (never
 *  null) for cost/tokens, `tokensCached` null when nothing under it reported. */
export function toolNode(o: {
  id: number; depth: number; at: number; ms: number | null; label: string
  toolStatus?: string | null; attribution?: string | null; calls?: number
  incomplete?: boolean
}): TraceTreeNode {
  return {
    ...BLANK,
    type: 'tool',
    id: o.id,
    depth: o.depth,
    label: o.label,
    startedAt: o.at,
    endedAt: o.ms == null ? null : o.at + o.ms,
    durationMs: o.ms,
    costUsd: 0,
    pricedCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokenCalls: 0,
    calls: o.calls ?? 0,
    incomplete: o.incomplete ?? false,
    toolStatus: o.toolStatus ?? 'ok',
    attribution: o.attribution ?? 'window',
  }
}

export function traceNode(o: {
  id: number; depth: number; at: number; ms: number | null; label: string
  status?: number | null; costUsd?: number; pricedCalls?: number
  tin?: number; tout?: number; cached?: number | null; tokenCalls?: number
  calls?: number; incomplete?: boolean; expiredCalls?: number
  attribution?: string | null
}): TraceTreeNode {
  return {
    ...BLANK,
    type: 'trace',
    id: o.id,
    depth: o.depth,
    label: o.label,
    startedAt: o.at,
    endedAt: o.ms == null ? null : o.at + o.ms,
    durationMs: o.ms,
    status: o.status === undefined ? 200 : o.status,
    costUsd: o.costUsd ?? 0,
    pricedCalls: o.pricedCalls ?? 0,
    tokensIn: o.tin ?? 0,
    tokensOut: o.tout ?? 0,
    tokensCached: o.cached === undefined ? null : o.cached,
    tokenCalls: o.tokenCalls ?? 0,
    calls: o.calls ?? 0,
    incomplete: o.incomplete ?? false,
    expiredCalls: o.expiredCalls ?? 0,
    attribution: o.attribution ?? 'exact',
  }
}

/** The twelve `$metadata` probes an SAP MCP server fires before it does any
 *  work — the discovery wall the fold exists to hide. All under one prefix so
 *  the fold's common tail is `…/opu/odata/sap/*`. */
const DISCOVERY = [
  'API_SALES_ORDER_SRV/$metadata',
  'API_BUSINESS_PARTNER/$metadata',
  'API_PRODUCT_SRV/$metadata',
  'API_MATERIAL_STOCK_SRV/$metadata',
  'API_PURCHASEORDER_PROCESS_SRV/$metadata',
  'API_SUPPLIER_INVOICE_SRV/$metadata',
  'API_BILLING_DOCUMENT_SRV/$metadata',
  'API_OUTBOUND_DELIVERY_SRV/$metadata',
  'API_CUSTOMER_RETURN_SRV/$metadata',
  'API_JOURNALENTRYITEMBASIC_SRV/$metadata',
  'API_COSTCENTER_SRV/$metadata',
  'API_OPLACCTGDOCITEMCUBE_SRV/$metadata',
]

/** in / cached / out / cost per turn — sums land on the mockup's headline
 *  numbers exactly: `$0.1448`, `342k↺→2.8k`, 48.3s. */
const TURNS = [
  { at: 2100, ms: 5600, tin: 46_900, cached: 44_100, tout: 412, cost: 0.0203 },
  { at: 9100, ms: 3200, tin: 47_300, cached: 45_200, tout: 380, cost: 0.0206 },
  { at: 13_500, ms: 8400, tin: 48_100, cached: 45_900, tout: 655, cost: 0.0242 },
  { at: 23_700, ms: 4100, tin: 48_900, cached: 46_500, tout: 410, cost: 0.0215 },
  { at: 29_300, ms: 3900, tin: 49_400, cached: 47_000, tout: 520, cost: 0.0221 },
  { at: 35_400, ms: 4400, tin: 50_100, cached: 47_600, tout: 300, cost: 0.0209 },
  { at: 42_900, ms: 2900, tin: 51_300, cached: 48_200, tout: 145, cost: 0.0152 },
]
const TURN_IDS = [14, 17, 20, 22, 25, 29, 30]

interface ToolSpec {
  id: number; at: number; ms: number; toolStatus?: string
  kids: Array<{ id: number; at: number; ms: number; endpoint: string; method?: string; status?: number }>
}

const TOOLS: ToolSpec[] = [
  { id: 31, at: 7700, ms: 1400, kids: [
    { id: 15, at: 7750, ms: 620, endpoint: 'API_SALES_ORDER_SRV/A_SalesOrder' },
    { id: 16, at: 8500, ms: 180, endpoint: 'API_SALES_ORDER_SRV/A_SalesOrder/$count' },
  ] },
  { id: 32, at: 12_300, ms: 1200, kids: [
    { id: 18, at: 12_350, ms: 500, endpoint: 'API_BUSINESS_PARTNER/A_BusinessPartner' },
    { id: 19, at: 12_900, ms: 400, endpoint: 'API_BUSINESS_PARTNER/A_Customer' },
  ] },
  { id: 33, at: 21_900, ms: 1800, toolStatus: 'error', kids: [
    { id: 21, at: 21_950, ms: 460, endpoint: 'API_SALES_ORDER_SRV/A_SalesOrder', method: 'POST', status: 400 },
  ] },
  { id: 34, at: 27_800, ms: 1500, kids: [
    { id: 23, at: 27_850, ms: 600, endpoint: 'API_PRODUCT_SRV/A_Product' },
    { id: 24, at: 28_500, ms: 700, endpoint: 'API_PRODUCT_SRV/A_ProductDescription' },
  ] },
  { id: 35, at: 33_200, ms: 2200, kids: [
    { id: 26, at: 33_250, ms: 500, endpoint: 'API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod' },
    { id: 27, at: 33_800, ms: 600, endpoint: 'API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod/$count' },
    { id: 28, at: 34_500, ms: 700, endpoint: 'API_MATERIAL_STOCK_SRV/A_MaterialStock' },
  ] },
  { id: 36, at: 39_800, ms: 3100, toolStatus: 'unresolved', kids: [] },
  { id: 37, at: 45_800, ms: 1900, kids: [
    { id: 43, at: 45_850, ms: 500, endpoint: 'API_BILLING_DOCUMENT_SRV/A_BillingDocument' },
    { id: 44, at: 46_400, ms: 600, endpoint: 'API_BILLING_DOCUMENT_SRV/A_BillingDocumentItem' },
    { id: 45, at: 47_000, ms: 600, endpoint: 'API_BILLING_DOCUMENT_SRV/A_BillingDocPartner' },
  ] },
]

export const TOOL_LABEL = 'sap_execute_sap_operation'
export const ROOT_DURATION_MS = 48_300

export function referenceTree(over: {
  expiredCalls?: number
  incomplete?: boolean
  rootStatus?: number | null
} = {}): { root: TraceTreeNode; nodes: TraceTreeNode[] } {
  const nodes: TraceTreeNode[] = []
  const root = traceNode({
    id: 1, depth: 0, at: T0, ms: over.incomplete ? null : ROOT_DURATION_MS, label: ROOT_LABEL,
    status: over.rootStatus === undefined ? 200 : over.rootStatus,
    costUsd: 0.1448, pricedCalls: 7,
    tin: 342_000, tout: 2822, cached: 324_500, tokenCalls: 7, calls: 32,
    incomplete: over.incomplete ?? false,
    expiredCalls: over.expiredCalls ?? 0,
  })
  nodes.push(root)

  // The discovery wall: twelve consecutive sibling GETs, 175ms apart, the last
  // one closing at exactly T0+2100 so the fold span reads 2.1s.
  DISCOVERY.forEach((endpoint, i) => {
    nodes.push(apiReq({
      id: 2 + i, depth: 1, at: T0 + i * 175, ms: i === 11 ? 175 : 170,
      endpoint: SAP_PREFIX + endpoint,
    }))
  })

  // Turn n, then the tool it called — the agent loop, in wall order.
  TURNS.forEach((t, i) => {
    nodes.push(llmReq({ id: TURN_IDS[i], depth: 1, at: T0 + t.at, ms: t.ms, tin: t.tin, cached: t.cached, tout: t.tout, cost: t.cost }))
    const tool = TOOLS[i]
    nodes.push(toolNode({
      id: tool.id, depth: 1, at: T0 + tool.at, ms: tool.ms, label: TOOL_LABEL,
      toolStatus: tool.toolStatus ?? 'ok', calls: tool.kids.length,
    }))
    for (const k of tool.kids) {
      nodes.push(apiReq({
        id: k.id, depth: 2, at: T0 + k.at, ms: k.ms,
        endpoint: SAP_PREFIX + k.endpoint, method: k.method, status: k.status,
      }))
    }
  })

  return { root, nodes }
}

/** Six sibling GETs whose 4th failed: 3 clean before it, 2 after — neither run
 *  reaches FOLD_MIN, so nothing folds and the failure cannot hide. */
export function errorRunTree(): { root: TraceTreeNode; nodes: TraceTreeNode[] } {
  const root = traceNode({ id: 1, depth: 0, at: T0, ms: 6000, label: ROOT_LABEL, calls: 6 })
  const nodes: TraceTreeNode[] = [root]
  for (let i = 0; i < 6; i++) {
    nodes.push(apiReq({
      id: 2 + i, depth: 1, at: T0 + i * 500, ms: 400,
      endpoint: SAP_PREFIX + DISCOVERY[i], status: i === 3 ? 500 : 200,
    }))
  }
  return { root, nodes }
}

/** One LLM request that never reported usage — the `—` case — plus a plain API
 *  sibling for the blank case. Single LLM row, so no turn ordinals. */
export function usagelessLlmTree(): { root: TraceTreeNode; nodes: TraceTreeNode[] } {
  const root = traceNode({ id: 1, depth: 0, at: T0, ms: 3000, label: ROOT_LABEL, calls: 2 })
  return {
    root,
    nodes: [
      root,
      llmReq({ id: 2, depth: 1, at: T0, ms: 1200, tin: null, cached: null, tout: null, cost: null }),
      apiReq({ id: 3, depth: 1, at: T0 + 1300, ms: 300, endpoint: SAP_PREFIX + DISCOVERY[0] }),
    ],
  }
}
