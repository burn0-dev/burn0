/** Pure layout math for the LLM trace workspace (spec 2026-08-06).
 *
 *  Everything here is a function of AVAILABLE CONTENT COLUMNS — the cells left
 *  after App's own padding — never the raw terminal width. The invariant every
 *  return value obeys: widths plus dividers spend the input exactly, never one
 *  cell more. No Ink, no React: a suite can pin every boundary without opening
 *  a terminal. */

export type WorkspaceMode = 'narrow' | 'medium' | 'wide'

export const MEDIUM_MIN = 110
export const WIDE_MIN = 160

/** The tree must keep a step name worth reading; below this the extra panes
 *  cost more than they show and the next layout down wins. */
const TREE_MIN = 44
const LIST_PANE_MIN = 34
const LIST_PANE_MAX = 42
const INSPECTOR_MIN = 32
const INSPECTOR_WIDE_MIN = 48
const INSPECTOR_WIDE_MAX = 64

export interface WorkspaceLayout {
  mode: WorkspaceMode
  /** Left trace-list pane — wide mode only. */
  list: number | null
  tree: number
  /** Right inspector pane — medium and wide. */
  inspector: number | null
  /** 1-cell dim dividers between panes; list+tree+inspector+dividers === columns. */
  dividers: number
}

export function workspaceLayout(columns: number): WorkspaceLayout {
  if (columns >= WIDE_MIN) {
    const list = Math.min(Math.max(Math.floor(columns * 0.23), LIST_PANE_MIN), LIST_PANE_MAX)
    const inspector = Math.min(Math.max(Math.floor(columns * 0.32), INSPECTOR_WIDE_MIN), INSPECTOR_WIDE_MAX)
    const tree = columns - list - inspector - 2
    if (tree >= TREE_MIN) return { mode: 'wide', list, tree, inspector, dividers: 2 }
    // Three unusable panes are worse than two good ones.
  }
  if (columns >= MEDIUM_MIN) {
    const tree = Math.max(TREE_MIN, Math.floor(columns * 0.6))
    const inspector = columns - tree - 1
    if (inspector >= INSPECTOR_MIN) return { mode: 'medium', list: null, tree, inspector, dividers: 1 }
  }
  return { mode: 'narrow', list: null, tree: columns, inspector: null, dividers: 0 }
}

// ---------------------------------------------------------------------------
// Tree numeric columns — hidden as whole units, values and headers together.
// ---------------------------------------------------------------------------

export const COST_W = 8
export const TOKENS_W = 12
export const TOOK_W = 7
export const COL_GAP = 2

/** STEP must stay a name, not a stub. */
const STEP_MIN = 26

export interface TreeColumns {
  cost: boolean
  tokens: boolean
  stepWidth: number
}

/** Shed order: TOKENS first, COST next; STEP and TOOK always render, complete —
 *  a header clipped to `TO…` is a failure, so a column either fits whole or is
 *  absent whole. */
export function treeColumns(width: number): TreeColumns {
  const withAll = width - (COST_W + TOKENS_W + TOOK_W + 3 * COL_GAP)
  if (withAll >= STEP_MIN) return { cost: true, tokens: true, stepWidth: withAll }
  const noTokens = width - (COST_W + TOOK_W + 2 * COL_GAP)
  if (noTokens >= STEP_MIN) return { cost: true, tokens: false, stepWidth: noTokens }
  const stepOnly = Math.max(1, width - (TOOK_W + COL_GAP))
  return { cost: false, tokens: false, stepWidth: stepOnly }
}

// ---------------------------------------------------------------------------
// Trace-list table columns (narrow/medium full-width list).
// ---------------------------------------------------------------------------

export interface ListColumnSet {
  time: boolean
  cost: boolean
  calls: boolean
  tokens: boolean
  dur: boolean
  steps: boolean
}

/** Column subsets by available width. The old fixed seven-column set needed 90
 *  cells and wrapped at every ordinary terminal; here a set is only offered
 *  when it provably fits. Trace name and Dur always stay; Tokens goes first,
 *  then Steps, then Calls, then Cost, then Time. */
export function listColumns(width: number): ListColumnSet {
  return {
    time: width >= 46,
    cost: width >= 58,
    calls: width >= 68,
    steps: width >= 80,
    tokens: width >= 97,
    dur: true,
  }
}
