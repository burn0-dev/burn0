import { describe, it, expect } from 'vitest'
import { buildRows, FOLD_MIN, rowKey, type DisplayRow } from '../src/tui/tree-model.js'
import { visWidth } from '../src/tui/glyphs.js'
import { theme } from '../src/tui/theme.js'
import {
  referenceTree, errorRunTree, usagelessLlmTree, nestedTraceTree, toolTokenTree,
  traceNode, apiReq, toolNode, ROOT_LABEL, TOOL_LABEL, SAP_PREFIX, T0,
} from './helpers/tree-fixture.js'

const tree = referenceTree()
const withError = errorRunTree()

const NONE = () => new Set<string>()

/** Default view of the reference trace at the 140-column STEP width. */
function rows(over: Partial<Parameters<typeof buildRows>[0]> = {}): DisplayRow[] {
  return buildRows({
    tree, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false, ...over,
  })
}

const step = (r: DisplayRow) => r.step.trimEnd()

describe('buildRows — folds', () => {
  it('folds the 12-GET discovery wall into one collapsed row with count and span', () => {
    const r = rows()
    const fold = r.find((x) => x.kind === 'fold')!
    expect(fold).toBeDefined()
    expect(fold.step).toContain('12× GET')
    expect(fold.step).toContain('sap.com')
    expect(fold.took).toBe('2.1s')
    expect(fold.cost).toBe('—')
    expect(fold.tokens).toBe('')
    expect(fold.isBranch).toBe(true)
    expect(fold.key).toBe('fold:req:2')
    // members hidden
    expect(r.filter((x) => x.node?.type === 'request' && x.node.method === 'GET'
      && x.node.depth === 1 && !x.step.includes('×')).length).toBe(0)
  })

  it('the fold names what it aggregates: verb, entity, common tail with *', () => {
    const fold = rows({ stepWidth: 66 }).find((x) => x.kind === 'fold')!
    expect(step(fold)).toBe(`├ ▸ 12× GET sap.com  ${SAP_PREFIX}*`)
    expect(fold.members?.length).toBe(12)
  })

  it('an error row breaks a fold — a failure can never hide inside one', () => {
    const r = buildRows({ tree: withError, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(r.some((x) => x.kind === 'fold')).toBe(false)   // 3 before + 2 after, both under FOLD_MIN
    expect(r.find((x) => x.node?.status === 500)!.stepColor).toBe(theme.err)
    expect(r.find((x) => x.node?.status === 500)!.step).toContain('500')
  })

  it('a null-status row breaks a fold too — no response is a failure', () => {
    const t = traceNode({ id: 1, depth: 0, at: T0, ms: 5000, label: ROOT_LABEL })
    const kids = [0, 1, 2, 3, 4].map((i) => apiReq({
      id: 2 + i, depth: 1, at: T0 + i * 100, ms: 90,
      endpoint: `${SAP_PREFIX}A_${i}`, status: i === 2 ? null : 200,
    }))
    const r = buildRows({
      tree: { root: t, nodes: [t, ...kids] }, expanded: NONE(), collapsed: NONE(),
      stepWidth: 53, flat: false,
    })
    expect(r.some((x) => x.kind === 'fold')).toBe(false)
    const failed = r.find((x) => x.node?.id === 4)!
    expect(failed.stepColor).toBe(theme.err)
    expect(step(failed)).toMatch(/—$/)                     // applicable, unreported
  })

  it('FOLD_MIN is the threshold: 3 stay singles, 4 fold', () => {
    expect(FOLD_MIN).toBe(4)
    const make = (n: number) => {
      const t = traceNode({ id: 1, depth: 0, at: T0, ms: 5000, label: ROOT_LABEL })
      const kids = Array.from({ length: n }, (_, i) => apiReq({
        id: 2 + i, depth: 1, at: T0 + i * 100, ms: 90, endpoint: `${SAP_PREFIX}A_${i}`,
      }))
      return { root: t, nodes: [t, ...kids] }
    }
    const three = buildRows({ tree: make(3), expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(three.some((x) => x.kind === 'fold')).toBe(false)
    expect(three.filter((x) => x.node?.type === 'request').length).toBe(3)
    const four = buildRows({ tree: make(4), expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(four.filter((x) => x.kind === 'fold').length).toBe(1)
  })

  it('a different verb or host ends the run', () => {
    const t = traceNode({ id: 1, depth: 0, at: T0, ms: 5000, label: ROOT_LABEL })
    const kids = Array.from({ length: 8 }, (_, i) => apiReq({
      id: 2 + i, depth: 1, at: T0 + i * 100, ms: 90, endpoint: `${SAP_PREFIX}A_${i}`,
      method: i === 4 ? 'POST' : 'GET',
    }))
    const r = buildRows({
      tree: { root: t, nodes: [t, ...kids] }, expanded: NONE(), collapsed: NONE(),
      stepWidth: 53, flat: false,
    })
    expect(r.filter((x) => x.kind === 'fold').length).toBe(1)   // the 4 GETs before the POST
    expect(r.find((x) => x.kind === 'fold')!.step).toContain('4× GET')
    expect(r.filter((x) => x.node?.type === 'request').length).toBe(4)  // POST + the 3 trailing GETs
  })
})

describe('buildRows — names and suffixes', () => {
  it('LLM rows get turn ordinals and ↺ token cells', () => {
    const llm = rows().filter((r) => r.node?.model != null)
    expect(llm.length).toBe(7)
    expect(llm[0].step).toContain('claude-sonnet-5 #1')
    expect(llm[2].step).toContain('#3')
    expect(llm[0].tokens).toBe('46.9k↺→412')
    expect(llm[2].tokens).toBe('48.1k↺→655')
    expect(llm[0].cost).toBe('$0.0203')
  })

  it('a lone LLM request gets no ordinal — there is nothing to anchor against', () => {
    const r = buildRows({ tree: usagelessLlmTree(), expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    const llm = r.find((x) => x.node?.model != null)!
    expect(llm.step).toContain('claude-sonnet-5')
    expect(llm.step).not.toContain('#1')
  })

  it('API names are entity + non-GET verb + left-truncated tail', () => {
    const r = rows()
    const get = r.find((x) => x.node?.id === 15)!
    // The spec §2.6 mockup line, exactly: guides · marker · entity · two spaces
    // · elided head keeping its boundary slash · the tail that carries the signal.
    expect(step(get)).toBe('│ ├ ◇ sap.com  …/sap/API_SALES_ORDER_SRV/A_SalesOrder')
    expect(step(get)).not.toContain('GET')                 // the default verb is noise
    const post = r.find((x) => x.node?.id === 21)!
    expect(post.step).toContain('sap.com  POST ')
    expect(step(post)).toMatch(/ 400$/)
  })

  it('a short endpoint is rendered whole, with no elision mark', () => {
    const root = traceNode({ id: 1, depth: 0, at: T0, ms: 1000, label: ROOT_LABEL })
    const kid = apiReq({ id: 2, depth: 1, at: T0, ms: 90, endpoint: '/v1/charges', method: 'DELETE', host: 'api.stripe.com' })
    const r = buildRows({ tree: { root, nodes: [root, kid] }, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(step(r[1])).toBe('└ ◇ Stripe  DELETE /v1/charges')
  })

  it('the root carries the step mix, dropped whole when the name needs the room', () => {
    expect(step(rows()[0])).toBe(`${ROOT_LABEL} · 7◆ 7🔧 25◇`)
    expect(rows({ stepWidth: 35 })[0].step).not.toContain('◆')   // 35 < name + 14
    expect(rows({ stepWidth: 66 })[0].step).toContain('· 7◆ 7🔧 25◇')
  })

  it('tool rows carry attribution and status words', () => {
    const r = rows()
    expect(step(r.find((x) => x.key === 'tool:31')!)).toBe(`├ 🔧 ${TOOL_LABEL} ~`)
    expect(step(r.find((x) => x.key === 'tool:33')!)).toBe(`├ 🔧 ${TOOL_LABEL} ~ error`)
    expect(r.find((x) => x.key === 'tool:33')!.stepColor).toBe(theme.err)
    expect(step(r.find((x) => x.key === 'tool:36')!)).toBe(`├ 🔧 ${TOOL_LABEL} ~ unresolved`)
    expect(r.find((x) => x.key === 'tool:36')!.stepColor).toBe(theme.warn)
  })

  it('suffixes survive any width — names absorb truncation', () => {
    for (const w of [29, 35, 53, 66]) {
      const r = rows({ stepWidth: w })
      const err = r.find((x) => x.step.includes('error'))
      expect(err, `width ${w}`).toBeDefined()
      expect(r.find((x) => x.key === 'tool:36')!.step, `width ${w}`).toContain('unresolved')
      expect(r.find((x) => x.node?.id === 21)!.step, `width ${w}`).toContain('400')
      for (const row of r) expect(visWidth(row.step), `width ${w} · ${row.key}`).toBe(w)
    }
  })

  it('an incomplete trace is marked and reports no duration', () => {
    const t = referenceTree({ incomplete: true })
    const r = buildRows({ tree: t, expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false })
    expect(r[0].step).toContain('⚠ incomplete')
    expect(r[0].took).toBe('—')
    expect(r[0].stepColor).toBe(theme.warn)
  })
})

describe('buildRows — live, incomplete and status-null roots (spec §4)', () => {
  it('a live root gets ● LIVE and an elapsed, dim TOOK — never the expired wording', () => {
    const t = referenceTree({ live: true })
    const now = T0 + 14_000
    const r = buildRows({ tree: t, expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false, now })
    expect(r[0].step).toContain('● LIVE')
    expect(r[0].took).toBe('14s…')
    expect(r[0].tookEmphasis).toBe('dim')
    // still aggregates normally — the facts observed so far
    expect(r[0].cost).toBe('$0.1448')
  })

  it('is deterministic against the `now` passed in, not the wall clock', () => {
    const t = referenceTree({ live: true })
    const r1 = buildRows({ tree: t, expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false, now: T0 + 5000 })
    const r2 = buildRows({ tree: t, expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false, now: T0 + 5000 })
    expect(r1[0].took).toBe(r2[0].took)
    expect(r1[0].took).toBe('5s…')
  })

  it('a live root with no calls yet says so, and never says "expired"', () => {
    const root = traceNode({ id: 1, depth: 0, at: T0, ms: null, label: ROOT_LABEL, status: null, calls: 0 })
    const r = buildRows({
      tree: { root, nodes: [root] }, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false, now: T0 + 3000,
    })
    expect(r.length).toBe(2)
    expect(r[1].kind).toBe('info')
    expect(r[1].step).toContain('waiting for first call…')
    expect(r[1].step).not.toContain('expired')
    // also true in flat mode — the same notice, not hidden either way
    const flat = buildRows({
      tree: { root, nodes: [root] }, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: true, now: T0 + 3000,
    })
    expect(flat.some((x) => x.step.includes('waiting for first call'))).toBe(true)
  })

  it('a live root that already lost calls to the sweep reports the expiry, not "waiting"', () => {
    const root = traceNode({ id: 1, depth: 0, at: T0, ms: null, label: ROOT_LABEL, status: null, calls: 0, expiredCalls: 5 })
    const r = buildRows({
      tree: { root, nodes: [root] }, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false, now: T0 + 3000,
    })
    expect(r[1].step).toContain('5 calls expired')
    expect(r[1].step).not.toContain('waiting')
  })

  it('incomplete colors the whole row warn, live and status-null-closed never do', () => {
    const incomplete = buildRows({
      tree: referenceTree({ incomplete: true }), expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false,
    })
    expect(incomplete[0].stepColor).toBe(theme.warn)

    const live = buildRows({
      tree: referenceTree({ live: true }), expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false, now: T0,
    })
    expect(live[0].stepColor).not.toBe(theme.err)
    expect(live[0].stepColor).not.toBe(theme.warn)

    const closedUnknown = buildRows({
      tree: referenceTree({ rootStatus: null }), expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false,
    })
    expect(closedUnknown[0].stepColor).not.toBe(theme.err)
    expect(closedUnknown[0].stepColor).toBeUndefined()
  })

  it('a closed root with a null status reads dim "—", distinct from live and incomplete', () => {
    const r = buildRows({
      tree: referenceTree({ rootStatus: null }), expanded: NONE(), collapsed: NONE(), stepWidth: 66, flat: false,
    })
    expect(r[0].step.trimEnd().endsWith('—')).toBe(true)
    expect(r[0].stepDim).toBe(true)
    expect(r[0].step).not.toContain('LIVE')
    expect(r[0].step).not.toContain('incomplete')
  })

  it('a request with a null status stays red — the epistemic split holds', () => {
    const root = traceNode({ id: 1, depth: 0, at: T0, ms: 1000, label: ROOT_LABEL, status: null })
    const dead = apiReq({ id: 2, depth: 1, at: T0, ms: 100, endpoint: `${SAP_PREFIX}A_dead`, status: null })
    const r = buildRows({
      tree: { root, nodes: [root, dead] }, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false,
    })
    expect(r[0].stepColor).toBeUndefined()     // the trace root: dim, not red
    expect(r.find((x) => x.node?.id === 2)!.stepColor).toBe(theme.err)   // the request: red
  })

  it('every row stays exactly stepWidth cells across live/waiting/unknown-closed states', () => {
    const trees = [
      referenceTree({ live: true }),
      referenceTree({ rootStatus: null }),
    ]
    for (const t of trees) {
      for (const w of [29, 35, 53, 66, 98]) {
        const r = buildRows({ tree: t, expanded: NONE(), collapsed: NONE(), stepWidth: w, flat: false, now: T0 + 9000 })
        for (const row of r) expect(visWidth(row.step), `w${w}/${row.key}`).toBe(w)
      }
    }
    const empty = traceNode({ id: 1, depth: 0, at: T0, ms: null, label: ROOT_LABEL, status: null, calls: 0 })
    for (const w of [29, 35, 53, 66, 98]) {
      const r = buildRows({
        tree: { root: empty, nodes: [empty] }, expanded: NONE(), collapsed: NONE(), stepWidth: w, flat: false, now: T0,
      })
      for (const row of r) expect(visWidth(row.step), `waiting w${w}/${row.key}`).toBe(w)
    }
  })
})

describe('buildRows — guides and structure', () => {
  it('guides come from depth and last-sibling lookahead; the root has none', () => {
    const r = rows()
    expect(r[0].step.startsWith('POST')).toBe(true)
    expect(r.find((x) => x.key === 'tool:37')!.step.startsWith('└ ')).toBe(true)  // last child
    expect(r.find((x) => x.key === 'tool:31')!.step.startsWith('├ ')).toBe(true)
    expect(r.find((x) => x.node?.id === 15)!.step.startsWith('│ ├ ')).toBe(true)
    expect(r.find((x) => x.node?.id === 16)!.step.startsWith('│ └ ')).toBe(true)
    // last tool's children hang off a spent trunk
    expect(r.find((x) => x.node?.id === 43)!.step.startsWith('  ├ ')).toBe(true)
    expect(r.find((x) => x.node?.id === 45)!.step.startsWith('  └ ')).toBe(true)
  })

  it('the root is never a branch; tools with children are', () => {
    const r = rows()
    expect(r[0].isBranch).toBe(false)
    expect(r.find((x) => x.key === 'tool:31')!.isBranch).toBe(true)
    expect(r.find((x) => x.key === 'tool:36')!.isBranch).toBe(false)  // no children
    expect(r.find((x) => x.node?.id === 15)!.isBranch).toBe(false)
    expect(r.find((x) => x.node?.id === 15)!.requestId).toBe(15)
  })

  it('collapsed tool shows ▸N and aggregates; expanded set reopens a fold', () => {
    const collapsed = new Set(['tool:31'])
    const r = buildRows({ tree, expanded: NONE(), collapsed, stepWidth: 53, flat: false })
    expect(r.find((x) => x.key === 'tool:31')!.step).toMatch(/▸2\s*$/)
    expect(r.some((x) => x.node?.id === 15)).toBe(false)
    expect(r.some((x) => x.node?.id === 18)).toBe(true)               // sibling tool untouched
    const open = buildRows({ tree, expanded: new Set(['fold:req:2']), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(open.filter((x) => x.node?.depth === 1 && x.node.method === 'GET').length).toBe(12)
    expect(open.find((x) => x.kind === 'fold')!.step).toContain('▾')
    // members indent one level under the ▾ row and keep their own last-sibling flag
    expect(open.find((x) => x.node?.id === 2)!.step.startsWith('│ ├ ')).toBe(true)
    expect(open.find((x) => x.node?.id === 13)!.step.startsWith('│ └ ')).toBe(true)
  })

  it('default expansion stops at depth 2; deeper branches open on request', () => {
    const root = traceNode({ id: 1, depth: 0, at: T0, ms: 4000, label: ROOT_LABEL })
    const t1 = toolNode({ id: 2, depth: 1, at: T0, ms: 3000, label: 'outer', calls: 1 })
    const t2 = toolNode({ id: 3, depth: 2, at: T0, ms: 2000, label: 'inner', calls: 1 })
    const leaf = apiReq({ id: 4, depth: 3, at: T0, ms: 100, endpoint: `${SAP_PREFIX}A_deep` })
    const t = { root, nodes: [root, t1, t2, leaf] }
    const closed = buildRows({ tree: t, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(closed.map((x) => x.key)).toEqual(['trace:1', 'tool:2', 'tool:3'])
    expect(closed[2].step).toMatch(/▸1\s*$/)
    const open = buildRows({ tree: t, expanded: new Set(['tool:3']), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(open.map((x) => x.key)).toEqual(['trace:1', 'tool:2', 'tool:3', 'req:4'])
  })

  it('a nested withTrace renders as a sibling of the tools around it', () => {
    const r = buildRows({ tree: nestedTraceTree(), expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    // ALS parents the scope to the enclosing trace, so it sits between the two
    // tools by start time — inference never reparents explicit structure.
    expect(r.filter((x) => x.node?.depth === 1).map((x) => x.key)).toEqual(['tool:10', 'trace:11', 'tool:12'])
    const nested = r.find((x) => x.key === 'trace:11')!
    expect(step(nested)).toBe('├ checkout_flow')           // name only — no marker
    expect(nested.stepBold).toBe(true)
    expect(nested.stepColor).toBe('#ff7a00')               // accent
    expect(nested.isBranch).toBe(true)
    expect(nested.requestId).toBe(null)
  })

  it('a nested withTrace sums its subtree and spans its own window', () => {
    const r = buildRows({ tree: nestedTraceTree(), expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    const nested = r.find((x) => x.key === 'trace:11')!
    expect(nested.cost).toBe('$0.0321')
    expect(nested.tokens).toBe('20.0k↺→480')
    expect(nested.took).toBe('3.0s')
    expect(r.filter((x) => x.node?.depth === 2).map((x) => x.key))
      .toEqual(['req:2', 'req:3', 'req:4', 'req:5'])       // children visible by default
  })

  it('a collapsed withTrace reports what it is hiding', () => {
    const r = buildRows({
      tree: nestedTraceTree(), expanded: NONE(), collapsed: new Set(['trace:11']),
      stepWidth: 53, flat: false,
    })
    expect(step(r.find((x) => x.key === 'trace:11')!)).toBe('├ checkout_flow ▸2')
    expect(r.some((x) => x.key === 'req:3')).toBe(false)
    expect(r.some((x) => x.key === 'req:2')).toBe(true)     // the sibling tool is untouched
    expect(r.find((x) => x.key === 'trace:11')!.cost).toBe('$0.0321')  // aggregates still shown
  })

  it('row keys are stable identities, not indexes', () => {
    const r = rows()
    expect(r[0].key).toBe('trace:1')
    expect(rowKey(tree.nodes[13])).toBe('req:14')
    expect(new Set(r.map((x) => x.key)).size).toBe(r.length)
  })
})

describe('buildRows — cells', () => {
  it('blank vs — : API rows blank, LLM-without-usage —', () => {
    expect(rows().find((r) => r.node?.type === 'request' && r.node.model == null)!.tokens).toBe('')
    const u = buildRows({ tree: usagelessLlmTree(), expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(u.find((r) => r.node?.model != null && r.node.tokensIn == null)!.tokens).toBe('—')
    expect(u.find((r) => r.node?.model != null)!.cost).toBe('—')
  })

  it('tool rows without LLM descendants show blank tokens and — cost', () => {
    const tool = rows().find((r) => r.key === 'tool:31')!
    expect(tool.tokens).toBe('')
    expect(tool.cost).toBe('—')
    expect(tool.took).toBe('1.4s')
  })

  it('a tool with a reporting LLM descendant sums it; one with a silent LLM says —', () => {
    const r = buildRows({ tree: toolTokenTree(), expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    const reported = r.find((x) => x.key === 'tool:10')!
    expect(reported.tokens).toBe('12.0k↺→340')             // Σ over the subtree
    expect(reported.cost).toBe('$0.0050')
    const silent = r.find((x) => x.key === 'tool:11')!
    expect(silent.tokens).toBe('—')                        // applicable, unreported
    expect(silent.cost).toBe('—')
    // and the three states are genuinely three, not two
    expect(r.find((x) => x.node?.id === 3)!.tokens).toBe('—')   // the silent LLM leaf
    expect(rows().find((x) => x.key === 'tool:31')!.tokens).toBe('')  // no LLM beneath at all
  })

  it('the root sums its subtree honestly', () => {
    const root = rows()[0]
    expect(root.cost).toBe('$0.1448')
    expect(root.tokens).toBe('342k↺→2.8k')
    expect(root.took).toBe('48.3s')
    expect(root.tookEmphasis).toBe('normal')
  })

  it('TOOK emphasis is trace-relative: only the ≥15% row is normal', () => {
    const r = rows()
    expect(r.find((x) => x.step.includes('#3'))!.tookEmphasis).toBe('normal')   // 8.4s of 48.3s
    expect(r.find((x) => x.step.includes('#2'))!.tookEmphasis).toBe('dim')
    expect(r.find((x) => x.step.includes('#1'))!.tookEmphasis).toBe('dim')
  })

  it('≥40% of the trace is warn, and the denominator falls back to the widest node', () => {
    const root = traceNode({ id: 1, depth: 0, at: T0, ms: null, label: ROOT_LABEL, status: null })
    const fast = apiReq({ id: 2, depth: 1, at: T0, ms: 100, endpoint: `${SAP_PREFIX}A_fast` })
    const slow = apiReq({ id: 3, depth: 1, at: T0, ms: 1000, endpoint: `${SAP_PREFIX}A_slow` })
    const r = buildRows({
      tree: { root, nodes: [root, fast, slow] }, expanded: NONE(), collapsed: NONE(),
      stepWidth: 53, flat: false,
    })
    expect(r.find((x) => x.node?.id === 3)!.tookEmphasis).toBe('warn')   // 1000/1000
    expect(r.find((x) => x.node?.id === 2)!.tookEmphasis).toBe('dim')    // 100/1000
  })
})

describe('buildRows — flat mode and info rows', () => {
  it('flat mode keeps only request rows in seq order, plus info rows', () => {
    const r = buildRows({ tree, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: true })
    expect(r.every((x) => x.kind !== 'node' || x.node!.type === 'request'
      || (x.node!.type === 'trace' && x.node!.depth === 0))).toBe(true)
    expect(r.filter((x) => x.node?.type === 'request').length).toBe(32)
    expect(r.some((x) => x.kind === 'fold')).toBe(false)
    const ats = r.filter((x) => x.node?.type === 'request').map((x) => x.node!.startedAt)
    expect(ats).toEqual([...ats].sort((a, b) => a - b))
    expect(r.every((x) => !x.step.startsWith('│') && !x.step.startsWith('├'))).toBe(true)
  })

  it('expired calls raise an info row in both modes — a data-loss notice is never hidden', () => {
    const t = referenceTree({ expiredCalls: 9 })
    for (const flat of [false, true]) {
      const r = buildRows({ tree: t, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat })
      const info = r.find((x) => x.kind === 'info')!
      expect(info, `flat=${flat}`).toBeDefined()
      expect(info.step).toContain('9 earlier calls expired')
      expect(info.isBranch).toBe(false)
      expect(info.requestId).toBe(null)
      expect(info.cost).toBe('')
      expect(visWidth(info.step)).toBe(53)
    }
  })

  it('a fully expired trace says so instead of pretending it is empty', () => {
    const root = traceNode({ id: 1, depth: 0, at: T0, ms: 1000, label: ROOT_LABEL, expiredCalls: 14 })
    const r = buildRows({ tree: { root, nodes: [root] }, expanded: NONE(), collapsed: NONE(), stepWidth: 53, flat: false })
    expect(r.length).toBe(2)
    expect(r[1].step).toContain('14 calls expired (older than 30d)')
  })
})

describe('buildRows — width discipline', () => {
  it('every step in every mode and width is exactly stepWidth cells', () => {
    const trees = [
      tree, errorRunTree(), usagelessLlmTree(), nestedTraceTree(), toolTokenTree(),
      referenceTree({ expiredCalls: 3, incomplete: true }),
    ]
    for (const t of trees) {
      for (const w of [29, 30, 35, 44, 53, 65, 66, 98]) {
        for (const flat of [false, true]) {
          const r = buildRows({
            tree: t, expanded: new Set(['fold:req:2']), collapsed: new Set(['tool:31']), stepWidth: w, flat,
          })
          for (const row of r) expect(visWidth(row.step), `${w}/${flat}/${row.key}`).toBe(w)
        }
      }
    }
  })

  it('indentation caps at six levels so a deep chain never eats the name', () => {
    const nodes = [traceNode({ id: 1, depth: 0, at: T0, ms: 1000, label: ROOT_LABEL })]
    for (let d = 1; d <= 9; d++) {
      nodes.push(toolNode({ id: 1 + d, depth: d, at: T0, ms: 900, label: `tool_${d}`, calls: 1 }))
    }
    const expanded = new Set(nodes.map((n) => rowKey(n)))
    const r = buildRows({ tree: { root: nodes[0], nodes }, expanded, collapsed: NONE(), stepWidth: 53, flat: false })
    expect(r.length).toBe(10)
    const indent = (s: string) => (s.match(/^(?:[│├└] {1}| {2})*/)?.[0].length ?? 0)
    expect(indent(r[1].step)).toBe(2)
    expect(indent(r[6].step)).toBe(12)                     // depth 6 — the cap
    expect(Math.max(...r.map((x) => indent(x.step)))).toBe(12)
    expect(r[9].step).toContain('tool_9')                  // deeper rows still show their name
  })

  it('LLM rows never leak the endpoint — the model is the name', () => {
    for (const r of rows()) expect(r.step).not.toContain('/v1/messages')
  })

  it('rejects nothing at the minimum spec width of 29', () => {
    const r = rows({ stepWidth: 29 })
    expect(r.length).toBe(rows().length)
    for (const row of r) expect(visWidth(row.step)).toBe(29)
  })
})

describe('buildRows — colors', () => {
  it('red is failure only; API rows are otherwise dim and LLM rows magenta', () => {
    const r = rows()
    const ok = r.find((x) => x.node?.id === 15)!
    expect(ok.stepColor).toBeUndefined()
    expect(ok.stepDim).toBe(true)
    expect(r.find((x) => x.node?.id === 21)!.stepColor).toBe(theme.err)     // 400
    expect(r.find((x) => x.node?.id === 14)!.stepColor).toBe('magentaBright')
    expect(r[0].stepColor).toBe('#ff7a00')
    expect(r[0].stepBold).toBe(true)
    expect(r.find((x) => x.kind === 'fold')!.stepDim).toBe(true)
  })

  it('a tool that merely ran is cyan — a status word is what makes it loud', () => {
    expect(rows().find((x) => x.key === 'tool:31')!.stepColor).toBe('cyan')
  })
})
