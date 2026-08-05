import type { TraceTreeNode } from '@burn0/core'
import { detectEntity } from '@burn0/core'
import { G, padCell, truncLeft, visWidth } from './glyphs.js'
import { fmtTokPair, fmtUsd, fmtMs } from '../format.js'
import { theme } from './theme.js'

/** Every layout decision the trace tree makes, as data. No Ink, no React, no
 *  clock, no database — hand it a `traceTree` result and it hands back the rows
 *  a renderer paints verbatim (spec §2). Keeping the math here is what makes it
 *  testable at four terminal widths in a suite that never opens a terminal. */
export interface DisplayRow {
  /** Stable identity: `trace:4` · `tool:31` · `req:17` · `fold:req:12` ·
   *  `info:expired:4`. The cursor keys on this, never on an index — a row must
   *  not slide out from under the selection when the 1s poll appends. */
  key: string
  kind: 'node' | 'fold' | 'info'
  /** Present iff `kind === 'node'`. */
  node?: TraceTreeNode
  /** Members of a fold row, in order — the fold detail pane summarizes these. */
  members?: TraceTreeNode[]
  /** `⏎`/`h`/`l` toggle this row. The root is never a branch: it is the whole
   *  screen, and collapsing it would leave nothing behind. */
  isBranch: boolean
  /** `⏎` payload target on leaves; null on branches, folds and info rows. */
  requestId: number | null
  /** The STEP cell, composed to exactly `stepWidth` display cells. */
  step: string
  stepColor?: string
  stepBold?: boolean
  stepDim?: boolean
  cost: string
  tokens: string
  took: string
  tookEmphasis: 'dim' | 'normal' | 'warn'
}

/** Consecutive sibling requests needed before a run folds. Four is the point at
 *  which a repeated call stops being a step and starts being a wall. A named
 *  constant, not config — a threshold the user can move is a threshold nobody
 *  can reason about (spec §2.3). */
export const FOLD_MIN = 4

/** Rows down to this depth are visible without asking; branches below it open
 *  on `l`/`⏎`. Deep enough to show a turn's tool calls, shallow enough that a
 *  nested agent does not dump its whole transcript on arrival (spec §4). */
export const DEFAULT_VISIBLE_DEPTH = 2

/** Indentation stops here. Past six levels the guides cost more name than the
 *  nesting is worth, and the row type already says what the row is (spec §4). */
export const MAX_GUIDE_DEPTH = 6

/** Entity names are an orientation cue, not the payload — 10 cells, then `…`. */
const ENTITY_MAX = 10

const WARN_SHARE = 0.40
const NORMAL_SHARE = 0.15

export function rowKey(n: TraceTreeNode): string {
  return `${n.type === 'request' ? 'req' : n.type}:${n.id}`
}

/** Folds key on their first member's request id, not their position: a live
 *  append that lengthens the run must not silently re-key an open fold. */
export function foldKey(first: TraceTreeNode): string {
  return `fold:req:${first.requestId ?? first.id}`
}

export function buildRows(opts: {
  tree: { root: TraceTreeNode; nodes: TraceTreeNode[] }
  /** Keys the user explicitly toggled OPEN — folds, and branches below
   *  `DEFAULT_VISIBLE_DEPTH`. */
  expanded: Set<string>
  /** Keys the user explicitly toggled CLOSED. Wins over everything. */
  collapsed: Set<string>
  stepWidth: number
  flat: boolean
}): DisplayRow[] {
  const { tree, expanded, collapsed, flat } = opts
  const nodes = tree.nodes
  if (nodes.length === 0) return []
  const w = Math.max(1, Math.floor(opts.stepWidth))

  // Denominator for the relative-timing rule. While the root is still open it
  // has no duration, so the widest thing we did observe stands in for it —
  // never 0, which would paint every row warn.
  const rootDur = tree.root.durationMs
    ?? Math.max(...nodes.map((n) => n.durationMs ?? 0), 1)

  // ---- structure: parent/child links from the DFS depth transitions ----------
  const parentOf = new Array<number>(nodes.length).fill(-1)
  const childrenOf: number[][] = nodes.map(() => [])
  const stack: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    while (stack.length > 0 && nodes[stack[stack.length - 1]].depth >= nodes[i].depth) stack.pop()
    const p = stack.length > 0 ? stack[stack.length - 1] : -1
    parentOf[i] = p
    if (p >= 0) childrenOf[p].push(i)
    stack.push(i)
  }

  // Whether anything in a subtree ever spoke to a model. This is what separates
  // a blank TOKENS cell (not a concept for this row) from `—` (it is, and
  // nobody reported it) — §1.3's distinction, carried up the tree.
  const hasLlm = new Array<boolean>(nodes.length).fill(false)
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (isLlmRow(nodes[i])) hasLlm[i] = true
    if (hasLlm[i] && parentOf[i] >= 0) hasLlm[parentOf[i]] = true
  }

  // ---- turn ordinals: 1..n over LLM requests in seq order -------------------
  // A single turn needs no anchor; seven identical model names do.
  const llmOrder = nodes
    .map((n, i) => ({ n, i }))
    .filter((x) => x.n.type === 'request' && isLlmRow(x.n))
    .sort((a, b) => a.n.startedAt - b.n.startedAt || a.n.id - b.n.id)
  const ordinal = new Map<number, number>()
  if (llmOrder.length >= 2) llmOrder.forEach((x, k) => ordinal.set(x.i, k + 1))

  // ---- counters the root's step mix reports ---------------------------------
  const mix = {
    llm: nodes.filter((n) => n.type === 'request' && isLlmRow(n)).length,
    tool: nodes.filter((n) => n.type === 'tool').length,
    api: nodes.filter((n) => n.type === 'request' && !isLlmRow(n)).length,
  }

  const ctx: Ctx = { nodes, childrenOf, hasLlm, ordinal, mix, rootDur, w, expanded, collapsed, flat }
  const rows: DisplayRow[] = []

  if (flat) {
    // Flat mode answers "what calls happened, in what order" — structure is
    // exactly what it drops. Info rows stay: hiding a data-loss notice in one
    // mode is still hiding data.
    rows.push(nodeRow(ctx, 0, [], false))
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].expiredCalls > 0) rows.push(infoRow(ctx, i, [], false))
    }
    const reqs = nodes
      .map((n, i) => ({ n, i }))
      .filter((x) => x.n.type === 'request')
      .sort((a, b) => a.n.startedAt - b.n.startedAt || a.n.id - b.n.id)
    for (const x of reqs) rows.push(nodeRow(ctx, x.i, [], false))
    return rows
  }

  rows.push(nodeRow(ctx, 0, [], false))
  emitChildren(ctx, rows, 0, [])
  return rows
}

interface Ctx {
  nodes: TraceTreeNode[]
  childrenOf: number[][]
  hasLlm: boolean[]
  ordinal: Map<number, number>
  mix: { llm: number; tool: number; api: number }
  rootDur: number
  w: number
  expanded: Set<string>
  collapsed: Set<string>
  flat: boolean
}

type Group =
  | { kind: 'single'; idx: number }
  | { kind: 'fold'; idxs: number[] }

function emitChildren(ctx: Ctx, rows: DisplayRow[], parent: number, anc: string[]): void {
  const kids = ctx.childrenOf[parent]
  const groups = foldRuns(ctx, kids)
  const withInfo: Array<Group | { kind: 'info'; idx: number }> =
    ctx.nodes[parent].expiredCalls > 0 ? [{ kind: 'info', idx: parent }, ...groups] : groups

  withInfo.forEach((g, gi) => {
    const last = gi === withInfo.length - 1
    if (g.kind === 'info') { rows.push(infoRow(ctx, g.idx, anc, last)); return }

    if (g.kind === 'single') {
      const i = g.idx
      rows.push(nodeRow(ctx, i, anc, last))
      if (ctx.childrenOf[i].length > 0 && isOpen(ctx, i)) {
        emitChildren(ctx, rows, i, [...anc, last ? G.guideGap : G.guideV])
      }
      return
    }

    // A fold sits where its members sat; opening it indents them one level
    // under the `▾` header, so the header reads as the thing that contains them.
    const open = isFoldOpen(ctx, ctx.nodes[g.idxs[0]])
    rows.push(foldRow(ctx, g.idxs, anc, last, open))
    if (!open) return
    const inner = [...anc, last ? G.guideGap : G.guideV]
    g.idxs.forEach((i, k) => rows.push(nodeRow(ctx, i, inner, k === g.idxs.length - 1)))
  })
}

/** Runs of consecutive sibling API leaves that agree on host and verb and all
 *  succeeded. Any error — or a null status, which is a failure we could not even
 *  read — ends the run where it stands: a fold that swallowed a failure would
 *  be a lie told by omission (spec §2.3). */
function foldRuns(ctx: Ctx, kids: number[]): Group[] {
  const out: Group[] = []
  let run: number[] = []
  const flush = () => {
    if (run.length >= FOLD_MIN) out.push({ kind: 'fold', idxs: run })
    else for (const i of run) out.push({ kind: 'single', idx: i })
    run = []
  }
  for (const i of kids) {
    const n = ctx.nodes[i]
    if (!foldable(n)) { flush(); out.push({ kind: 'single', idx: i }); continue }
    const head = run.length > 0 ? ctx.nodes[run[0]] : null
    if (head && (head.hostname !== n.hostname || head.method !== n.method)) flush()
    run.push(i)
  }
  flush()
  return out
}

function foldable(n: TraceTreeNode): boolean {
  return n.type === 'request' && !isLlmRow(n) && n.status != null && n.status < 400
}

function isLlmRow(n: TraceTreeNode): boolean {
  return n.type === 'request' && (n.model != null || n.llm)
}

function failed(n: TraceTreeNode): boolean {
  return n.status == null || n.status >= 400
}

function isOpen(ctx: Ctx, i: number): boolean {
  const n = ctx.nodes[i]
  if (n.depth === 0) return true                      // the root does not collapse
  const key = rowKey(n)
  if (ctx.collapsed.has(key)) return false
  return n.depth < DEFAULT_VISIBLE_DEPTH || ctx.expanded.has(key)
}

function isFoldOpen(ctx: Ctx, first: TraceTreeNode): boolean {
  const key = foldKey(first)
  return ctx.expanded.has(key) && !ctx.collapsed.has(key)
}

// ---------------------------------------------------------------------------
// Row composition
// ---------------------------------------------------------------------------

function guides(ctx: Ctx, anc: string[], own: string): string {
  // Flat mode has no structure to draw. Otherwise: ancestors past the cap are
  // dropped rather than the row's own connector — losing the trunk costs
  // orientation, losing the connector costs the shape.
  if (ctx.flat) return ''
  return [...anc.slice(0, MAX_GUIDE_DEPTH - 1), own].join('')
}

/** `{guides}{marker}{name}{suffix}`, exactly `w` cells. Everything but the name
 *  is reserved first and the name is handed what is left: a clipped endpoint is
 *  an inconvenience, a clipped `error` is a lie (spec §2.1). `name` is a
 *  function of its budget because some names truncate from the left. */
function compose(
  w: number, guidePrefix: string, marker: string, suffix: string,
  name: (budget: number) => string,
): string {
  const budget = w - visWidth(guidePrefix) - visWidth(marker) - visWidth(suffix)
  return padCell(guidePrefix + marker + fit(name(budget), budget) + suffix, w)
}

/** Right-truncate to at most `w` cells, adding `…` only when it had to cut.
 *  Never pads — padding before a suffix would push the suffix off the row. */
function fit(s: string, w: number): string {
  if (w <= 0) return ''
  return visWidth(s) <= w ? s : padCell(s, w)
}

function nodeRow(ctx: Ctx, i: number, anc: string[], last: boolean): DisplayRow {
  const n = ctx.nodes[i]
  const root = n.depth === 0
  const prefix = root ? '' : guides(ctx, anc, last ? G.guideL : G.guideT)
  const kids = ctx.childrenOf[i].length
  const branch = !root && n.type !== 'request' && kids > 0
  const shut = branch && !isOpen(ctx, i)

  let marker = ''
  let name: (budget: number) => string = () => n.label
  let suffix = ''
  let color: string | undefined
  let bold = false
  let dim = false

  if (n.type === 'request' && isLlmRow(n)) {
    marker = `${G.llm} `
    // The model is the name. A URL here would be `/v1/messages` on every row —
    // seven identical strings where the thing that varies is the model.
    name = () => n.model ?? entityOf(n)
    const nth = ctx.ordinal.get(i)
    suffix = (nth != null ? ` #${nth}` : '') + statusSuffix(n)
    color = failed(n) ? theme.err : theme.entityLlm
  } else if (n.type === 'request') {
    marker = `${G.api} `
    name = (b) => apiName(n, b)
    suffix = statusSuffix(n)
    if (failed(n)) color = theme.err
    else dim = true
  } else if (n.type === 'tool') {
    marker = `${G.tool} `
    suffix = attributionSuffix(n) + toolStatusSuffix(n) + incompleteSuffix(n) + shutSuffix(shut, kids)
    color = n.toolStatus === 'error' ? theme.err
      : n.toolStatus === 'unresolved' ? theme.warn
        : theme.model
  } else {
    // trace: the root, or a nested withTrace. No marker — the accent and the
    // absence of a glyph are what say "this is a scope, not a call".
    suffix = (root ? mixSuffix(ctx, n) : '')
      + (n.status != null && n.status >= 400 ? ` ${n.status}` : '')
      + incompleteSuffix(n) + shutSuffix(shut, kids)
    color = n.status != null && n.status >= 400 ? theme.err : theme.accent
    bold = true
  }

  return {
    key: rowKey(n),
    kind: 'node',
    node: n,
    isBranch: branch,
    requestId: n.requestId,
    step: compose(ctx.w, prefix, marker, suffix, name),
    ...(color != null ? { stepColor: color } : {}),
    ...(bold ? { stepBold: true } : {}),
    ...(dim ? { stepDim: true } : {}),
    cost: costCell(n),
    tokens: tokensCell(n, ctx.hasLlm[i]),
    took: fmtMs(n.durationMs),
    tookEmphasis: root ? 'normal' : emphasis(n.durationMs, ctx.rootDur),
  }
}

function foldRow(ctx: Ctx, idxs: number[], anc: string[], last: boolean, open: boolean): DisplayRow {
  const members = idxs.map((i) => ctx.nodes[i])
  const first = members[0]
  const prefix = guides(ctx, anc, last ? G.guideL : G.guideT)
  const marker = `${open ? G.foldOpen : G.foldClosed} `

  // `12× GET sap.com  …/opu/odata/sap/*` — the row states exactly what it
  // aggregates, so nothing is hidden behind a count.
  const lead = `${members.length}×${first.method ? ` ${first.method}` : ''} ${entityOf(first)}  `
  const shared = `${commonPathPrefix(members.map(endpointOf))}*`
  const name = (b: number) => lead + truncLeft(shared, Math.max(0, b - visWidth(lead)))
  const span = foldSpan(members)
  return {
    key: foldKey(first),
    kind: 'fold',
    members,
    isBranch: true,
    requestId: null,
    step: compose(ctx.w, prefix, marker, '', name),
    stepDim: true,
    cost: '—',
    tokens: '',
    took: fmtMs(span),
    tookEmphasis: emphasis(span, ctx.rootDur),
  }
}

function infoRow(ctx: Ctx, i: number, anc: string[], last: boolean): DisplayRow {
  const n = ctx.nodes[i]
  // The notice sits with the calls it is about: as the owning node's first
  // child, because the sweep takes the oldest rows first.
  const prefix = guides(ctx, anc, last ? G.guideL : G.guideT)
  const some = ctx.childrenOf[i].length > 0
  const plural = n.expiredCalls === 1 ? '' : 's'
  const text = `· ${n.expiredCalls} ${some ? 'earlier ' : ''}call${plural} expired (older than 30d)`
  return {
    key: `info:expired:${n.id}`,
    kind: 'info',
    isBranch: false,
    requestId: null,
    step: compose(ctx.w, prefix, '', '', () => text),
    stepDim: true,
    cost: '',
    tokens: '',
    took: '',
    tookEmphasis: 'dim',
  }
}

// ---------------------------------------------------------------------------
// Names, suffixes, cells
// ---------------------------------------------------------------------------

function entityOf(n: TraceTreeNode): string {
  return n.hostname ? fit(detectEntity(n.hostname).entity, ENTITY_MAX) : ''
}

/** `{entity}  {VERB unless GET} {tail}` — GET is the default and says nothing;
 *  every other verb changes what the call did and stays. The endpoint truncates
 *  from the LEFT: `…/A_SalesOrder` identifies the call, `/s4hanacloud/sap/o…`
 *  identifies the tenant (spec §2.2). */
function apiName(n: TraceTreeNode, budget: number): string {
  const ent = entityOf(n)
  const verb = n.method && n.method !== 'GET' ? `${n.method} ` : ''
  const lead = `${ent}${ent ? '  ' : ''}${verb}`
  return lead + truncLeft(endpointOf(n), Math.max(0, budget - visWidth(lead)))
}

function endpointOf(n: TraceTreeNode): string {
  const m = n.method
  return m && n.label.startsWith(`${m} `) ? n.label.slice(m.length + 1) : n.label
}

function statusSuffix(n: TraceTreeNode): string {
  if (n.status == null) return ' —'                    // asked, never answered
  return n.status >= 400 ? ` ${n.status}` : ''
}

function attributionSuffix(n: TraceTreeNode): string {
  return n.attribution === 'window' ? ' ~' : n.attribution === 'turn' ? ' ~turn' : ''
}

function toolStatusSuffix(n: TraceTreeNode): string {
  return n.toolStatus === 'error' ? ' error' : n.toolStatus === 'unresolved' ? ' unresolved' : ''
}

function incompleteSuffix(n: TraceTreeNode): string {
  return n.incomplete ? ` ${G.warnWord} incomplete` : ''
}

function shutSuffix(shut: boolean, kids: number): string {
  return shut ? ` ${G.foldClosed}${kids}` : ''
}

/** `· 7◆ 7🔧 25◇` — the shape of the trace at a glance. Dropped whole rather
 *  than truncated: half a census is not a census. */
function mixSuffix(ctx: Ctx, root: TraceTreeNode): string {
  if (ctx.w < visWidth(root.label) + 14) return ''
  const parts = [
    ctx.mix.llm > 0 ? `${ctx.mix.llm}${G.llm}` : '',
    ctx.mix.tool > 0 ? `${ctx.mix.tool}${G.tool}` : '',
    ctx.mix.api > 0 ? `${ctx.mix.api}${G.api}` : '',
  ].filter(Boolean)
  return parts.length > 0 ? ` · ${parts.join(' ')}` : ''
}

function costCell(n: TraceTreeNode): string {
  return n.pricedCalls > 0 ? fmtUsd(n.costUsd) : '—'
}

function tokensCell(n: TraceTreeNode, hasLlmDescendant: boolean): string {
  if (n.type === 'request') {
    return isLlmRow(n) ? fmtTokPair(n.tokensIn, n.tokensCached, n.tokensOut) : ''
  }
  if (!hasLlmDescendant) return ''
  return n.tokenCalls > 0 ? fmtTokPair(n.tokensIn, n.tokensCached, n.tokensOut) : '—'
}

/** Durations are relative or they are noise: 620ms means nothing until you know
 *  the trace took 48s. Absolute thresholds (`latencyColor`) paint every normal
 *  agent-loop LLM row red, which is why they are not used here (spec §2.4). */
function emphasis(ms: number | null, rootDur: number): 'dim' | 'normal' | 'warn' {
  if (ms == null || rootDur <= 0) return 'dim'
  const share = ms / rootDur
  return share >= WARN_SHARE ? 'warn' : share >= NORMAL_SHARE ? 'normal' : 'dim'
}

/** First member's start to the last member's end — the wall time the wall cost,
 *  which is the only number a fold can honestly report. */
function foldSpan(members: TraceTreeNode[]): number | null {
  let start = Infinity
  let end = -Infinity
  for (const m of members) {
    start = Math.min(start, m.startedAt)
    const e = m.endedAt ?? (m.durationMs != null ? m.startedAt + m.durationMs : null)
    if (e != null) end = Math.max(end, e)
  }
  return end > -Infinity && start < Infinity ? end - start : null
}

/** The longest path all members share, cut back to a segment boundary. A prefix
 *  sliced mid-identifier (`…/API_SALES_ORDER_S*`) claims a shared name that is
 *  not actually shared. */
function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return ''
  let p = paths[0]
  for (const q of paths) {
    let i = 0
    while (i < p.length && i < q.length && p[i] === q[i]) i++
    p = p.slice(0, i)
  }
  if (paths.some((q) => q !== p)) {
    const cut = p.lastIndexOf('/')
    p = cut >= 0 ? p.slice(0, cut + 1) : p
  }
  return p
}
