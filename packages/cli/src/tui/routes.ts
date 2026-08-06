import type { query } from '@burn0/core'

/** Route state for the Overview → entity → target → request drill-down.
 *  A leaf module (like `footer.ts`) so screens can share these types without
 *  importing `App.tsx` and creating a cycle.
 *
 *  Return states store stable KEYS, not row snapshots: on return the screen
 *  re-finds the key in fresh data and falls back to the stored cursor only if
 *  the row disappeared — a live list may have re-sorted while we were away. */

export interface EntityKey {
  entity: string
  entityClass: 'llm' | 'general'
}

/** `model` for LLM targets (null = calls whose model was never parsed);
 *  `method` + `endpoint` for API targets. Never a parsed display string. */
export interface TargetKey {
  model?: string | null
  method?: string
  endpoint?: string
}

export interface OverviewReturnState {
  windowDays: query.WindowDays
  selectedEntity: EntityKey | null
  fallbackCursor: number
  scroll: number
}

export interface EntityReturnState {
  selectedTarget: TargetKey | null
  fallbackCursor: number
  scroll: number
}

export type TuiRoute =
  | { kind: 'dashboard'; restore?: OverviewReturnState }
  | { kind: 'entity'; entity: string; entityClass: 'llm' | 'general'; restore?: EntityReturnState; returnTo: OverviewReturnState }
  | {
      kind: 'target'
      entity: string
      entityClass: 'llm' | 'general'
      target: TargetKey
      returnTo: { entity: EntityReturnState; overview: OverviewReturnState }
    }
  | { kind: 'request'; requestId: number; returnTo: Exclude<TuiRoute, { kind: 'request' }> }

export function targetLabel(t: TargetKey): string {
  if (t.method != null && t.endpoint != null) return `${t.method} ${t.endpoint}`
  return t.model ?? '(no model)'
}
