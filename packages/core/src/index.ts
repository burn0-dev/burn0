export * from './types.js'
export { detectEntity, normalizeEndpoint } from './entities/index.js'
export { loadConfig, type Burn0Config } from './config/index.js'
export { resolveProject, resolveService, type ProjectIdentity } from './project/index.js'
export {
  openDatabase, ensureProject, insertRows, insertRun, endRun, createWriter,
  type StorageDriver, type WriteCtx,
} from './storage/db.js'
export { pruneRetention, maybeVacuum } from './storage/retention.js'
export { loadPricing, computeCost, type PricingTable } from './pricing/index.js'
export { initBurn0, type Burn0Handle } from './init.js'
export * as query from './query/index.js'
export type {
  TraceRow, UsageRow, UsageNode, Scope, ProjectSummary, TraceFilter,
  TraceListRow, TraceTreeNode,
} from './query/index.js'
export { withTags, currentTags } from './context/index.js'
export { withTrace, type PendingTrace, type TraceStep } from './context/trace.js'
import { tag } from './context/index.js'
export const burn0 = { tag }
