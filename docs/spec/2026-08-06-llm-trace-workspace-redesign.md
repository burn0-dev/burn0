# LLM Trace Workspace and Request Detail Redesign

## Assignment

Redesign and implement burn0's **LLM tab, trace workspace, selected-node inspector, and full request-detail screen**. Treat this document as the implementation prompt. Preserve the existing trace data model, query semantics, privacy rules, polling behavior, and keyboard-first terminal experience. The problem is presentation, layout ownership, navigation, and viewport management—not capture or storage.

Work from `burn0-1/`. Read the repository `AGENTS.md` before changing code. Do not discard unrelated working-tree changes. Add focused tests and run the CLI test suite before handoff.

The target is a terminal-native interpretation of a professional trace viewer: a trace list, execution tree, and contextual inspector that remain visually connected. Do not imitate browser typography, floating controls, logos, or web cards. Use the terminal's strengths: exact columns, restrained color, stable panes, dense hierarchy, and explicit keyboard hints.

## Current Implementation to Preserve and Refactor

The relevant files are:

- `packages/cli/src/tui/App.tsx`: shell, tabs, scope, terminal dimensions, and footer.
- `packages/cli/src/tui/screens/TraceList.tsx`: LLM trace list, flat-mode toggle, trace selection.
- `packages/cli/src/tui/screens/TraceView.tsx`: tree navigation, folding, flat mode, polling, and current two-pane layout.
- `packages/cli/src/tui/tree-model.ts`: pure construction of tree rows and width-aware step text.
- `packages/cli/src/tui/screens/TraceDetail.tsx`: selected-node summaries for trace, fold, LLM, API, tool, and information rows.
- `packages/cli/src/tui/screens/Debug.tsx`: current full request payload screen.
- `packages/cli/src/tui/llm-io.ts`: provider-independent transcript extraction.
- `packages/cli/src/tui/token-block.ts`: token breakdown rules.
- `packages/cli/src/tui/ui.tsx`, `theme.ts`, and `glyphs.ts`: shared layout, palette, and display-width helpers.

Keep the current strengths: stable identity keys inside the tree, one-second live polling, live-tail behavior, `h/l` folding, `f` tree/flat switching, payload retention wording, null-versus-zero discipline, URL query redaction, lazy request-detail reads, tool attribution, incomplete/live states, and `◆` LLM / `◇` API / `🔧` tool semantics.

## Confirmed Defects

Fix these before judging the new visual design:

1. **The app and trace view disagree about width.** `App` uses `paddingX={1}`, leaving `columns - 2` content cells, while `TraceView` calculates and renders against the full terminal width. In two-pane mode, `paneWidth + gap + detailWidth` equals the terminal width and therefore overflows the parent by two cells. In single-pane mode, a row is `columns - 1`, still one cell wider than the parent content.

2. **The LLM trace table cannot fit common terminals.** Its seven columns have a 90-cell minimum. At an 80-column terminal, the app provides 78 cells and the table still renders 90, causing wrapping, clipping, and broken selection backgrounds. A width allocator must never return columns whose widths plus gaps exceed its input.

3. **Display-width rules are inconsistent.** The tree uses `string-width`, but `ui.tsx` truncates and pads using JavaScript `string.length`. Unicode, CJK, combining characters, and wide glyphs can move every following column. All terminal width math must use display-cell width.

4. **Colored inverse selection creates a rainbow row.** `TreeRow` and shared table rows use `inverse` while children retain semantic foreground colors. The selected root becomes orange, an LLM row becomes magenta, cost remains green, tokens become gray, and latency becomes yellow. Selection must be one subdued, continuous background across the row. Never use per-cell inverse video.

5. **The full payload screen is not scrollable.** `DebugScreen` has no input, cursor, viewport, or scroll state despite a comment claiming the screen scrolls. It renders the full conversation, headers, request body, response headers, response body, and stack into a fixed-height alternate-screen app. Long content is inaccessible.

6. **Payload sections collapse over their content.** Multiple bordered `Section` components are flex-shrunk inside the fixed-height parent. Borders are painted through text while request JSON, headers, and SSE data spill into adjacent sections. Rendering more intrinsic rows than the viewport can hold is forbidden.

7. **The request screen duplicates information without hierarchy.** The parsed LLM conversation is followed immediately by raw request and response bodies containing the same messages. Headers and streaming protocol frames receive the same visual weight as the user's prompt and model answer.

8. **The trace-list cursor is index-based.** A new trace inserted at the top during polling can silently move selection to another trace. Trace-list selection and return state must use trace/request identity, with index only as a fallback.

9. **Current tests miss the shell integration bug.** Most width tests render `TraceView` directly with forced columns. They verify that desired text exists but do not assert the maximum display width of every rendered line inside `App`.

## Non-Negotiable Layout Contract

There must be one authoritative content rectangle. `App` calculates the cells remaining after its horizontal padding and vertical chrome, then passes those dimensions down. Child screens must not call the raw terminal size and pretend they own cells consumed by the shell.

Use a shape such as:

```ts
interface Viewport {
  columns: number // available content cells after App padding
  rows: number    // available content rows between rules
}
```

Exact prop names may differ. The invariant matters:

```text
rendered line display width <= viewport.columns
rendered content rows       <= viewport.rows
```

For multiple panes:

```text
sum(pane widths) + sum(divider widths) = viewport.columns
```

Do not count outer padding twice. Do not rely on Ink clipping to correct arithmetic. Do not emit a truncated header such as `TO…`; either render `TOOK` completely or omit that entire optional column.

## Responsive Information Architecture

Use three layout modes. Thresholds are based on **available content columns**, not the raw terminal width. The exact boundary may move by a few cells after fixture testing, but it must be named, pure, and covered at boundary widths.

### Wide: 160 or more content columns

Render one persistent three-pane workspace:

```text
TRACES                 │ TRACE / EXECUTION                    │ DETAIL
14:02 email-agent   ✓  │ STEP                 COST TOKENS TOOK │ ◆ claude-sonnet-5 #3
      $0.0246 · 7.8s   │ email-agent          $... 17.8K 7.8s │ Anthropic · completed
13:58 email-agent   ✓  │ ├ ◆ model #1         $...  1.1K 620ms│ 3.2s · $0.0044
      $0.0108 · 4.1s   │ ├ 🔧 list_entities          —  1.5s │
                       │ │ └ ◇ sap.com               — 559ms │ USER
                       │ └ ◆ model #2         $...  7.8K 3.9s│ tell me how many...
                       │                                      │
                       │                                      │ ASSISTANT
                       │                                      │ Plant 1710 has...
```

- Left pane: compact trace list.
- Middle pane: execution tree for the selected trace.
- Right pane: inspector for the selected tree node.
- Use one-cell dim vertical dividers. Do not wrap every pane in a rounded border.
- Pane headers occupy the same first row. Any table headers occupy the same second row.
- All panes fill the available height. Content scrolls inside them; panes do not grow and push the footer away.

Suggested allocation:

```text
trace list: clamp(floor(width × 0.23), 34, 42)
inspector:  clamp(floor(width × 0.32), 48, 64)
tree:       all remaining cells after two 1-cell dividers
```

The tree must retain enough width to show a useful step name. If the allocation cannot satisfy minimums, fall back to the medium layout rather than squeezing three unusable panes onto the screen.

### Medium: 110–159 content columns

Render two panes:

```text
TRACE / EXECUTION                    │ DETAIL
STEP                 COST TOKENS TOOK│ selected-node inspector
...
```

The trace list is a separate screen at this width. Enter from the trace list opens the two-pane view; Escape returns to the same trace identity and scroll position. Prefer a one-cell divider to a two-cell blank gap. Allocate approximately 58–62% to the tree, but enforce explicit minimums for both panes and spend every available cell exactly once.

### Narrow: below 110 content columns

Keep the current successful interaction model:

- The LLM tab shows the trace list.
- Enter opens a full-width tree.
- Enter on a request opens a full-width detail screen.
- Escape returns one level and preserves trace, row, fold, mode, and scroll state.
- Do not attempt side-by-side panes.

The tree should still show complete headers. If all numeric columns do not fit, hide optional columns as units:

1. Hide `TOKENS` first.
2. Hide `COST` next only if necessary.
3. Always retain `STEP` and `TOOK`.

Values and headers use the same column-visibility decision. Numeric cells remain right-aligned. No row may wrap.

## Wide Trace List

The left pane cannot reuse the existing seven-column table. Use a compact two-line row without a surrounding card:

```text
14:02  email-agent                 ✓
       $0.0246 · 7.8s · 3◆ 2🔧 15◇
```

Rules:

- First line: time, trace name, and status. Reserve status before truncating the name.
- Second line: known cost or `—`, duration, and step mix. It is dim supporting information.
- Failed/incomplete status is semantic red/yellow; successful status does not need bright green on every row.
- The selected trace has one neutral background spanning the pane width. An inactive selection remains visible but dimmer when keyboard focus is in another pane.
- Polling does not steal selection. If the user is on the newest row and following live results, follow the new newest trace. Otherwise retain the selected trace ID.
- Show a count/range in the pane header, such as `TRACES  1–40 of 312`, only if it fits.
- Retain the current chronological order and scope behavior. Do not read request payloads for list rows.

## Execution Tree

Reuse `tree-model.ts`; it already handles nesting, folds, live/incomplete states, suffix reservation, relative latency emphasis, and display-cell-safe step composition.

The tree presentation must satisfy:

- Root trace, nested trace, LLM, tool, API, fold, live, incomplete, expired, and waiting rows remain distinguishable.
- Keep `◆`, `◇`, and `🔧`. Do not add provider logos or emoji badges.
- Tree guides are dim and visually continuous.
- `STEP`, `COST`, `TOKENS`, and `TOOK` align vertically across every depth.
- Reserve numeric suffixes before truncating the step name.
- Failed requests are red. Unknown/incomplete states are warnings, not fabricated failures.
- Latency yellow is allowed only when the existing relative-emphasis rule says it is noteworthy; red remains failure-only in this screen.
- A selected row uses a single `theme.selBg`-style background. Preserve semantic foreground color only when it remains legible; never invert individual colored cells.
- A selected row must be padded to the full tree width, including blank numeric cells.
- Long endpoints continue truncating from the left because the endpoint tail is more informative.
- Repeated calls continue folding at the existing threshold.

In wide mode, changing the selected trace replaces the middle tree and right inspector without navigating to another screen. Changing the selected tree row updates the inspector immediately. Keep fold/cursor state per trace while it remains in a small in-memory cache; at minimum, preserve it for the current trace when focus moves between panes.

## Inspector Pane

Replace the floating, auto-height rounded card with a full-height pane. The pane header and a compact identity block stay fixed; the body has its own scroll position when the inspector holds focus.

Do not draw a box around the entire inspector. Use whitespace and dim rules. A selected LLM node should resemble:

```text
DETAIL
◆ claude-sonnet-5  #3
Anthropic · completed
3.2s · first byte 1.1s · $0.0044
tokens  8,260 → 163

USER
tell me how many manufacturing units are there for 1710

ASSISTANT
Plant 1710 has 2,308 products/materials.

→ tool_name({compact argument preview})
```

Node-specific content:

- **Trace root:** trace name, status/live state, total duration, known cost and pricing coverage, call/LLM/tool/API counts, token coverage, slowest step, and concise issue list.
- **LLM request:** model/provider, status, duration, first byte, known cost, token summary, latest relevant user/tool-result input, assistant output, and tool-call previews. Collapse the system prompt to `SYSTEM · N chars` plus at most its first useful line.
- **Tool:** name, state, duration, attribution mode, calls beneath it, arguments, and result preview. Explicitly state unresolved/incomplete conditions.
- **API request:** entity, method and endpoint, status, duration/first byte, bytes, redacted query, response preview, and call site.
- **Fold:** count, shared endpoint/model, time span, errors, and aggregate facts.
- **Waiting/expired info:** retain the existing honest distinction. Never call uncaptured young payloads expired.

The inspector is a preview, not the raw dump. It must prioritize the user's input and model/tool output over headers and protocol frames. When more data exists, show an explicit `Enter: full detail` hint.

## Full Request Detail

Replace the current `DebugScreen` vertical dump with a real viewport. This applies when opening any LLM or API request from the trace tree, flat list, API tab, Logs, or drill-down screens.

### Fixed chrome

The top rows remain visible while content scrolls:

```text
◆ claude-sonnet-5 · Anthropic                         completed
POST /v1/messages · 14:02:07
3.2s · first byte 1.1s · $0.0044 · tokens 8,260 → 163

[Summary]  Input  Output  Metadata  Raw
────────────────────────────────────────────────────────────
```

For an API request, replace model/provider with entity and method/endpoint; omit inapplicable cost/tokens rather than manufacturing zeroes.

### Tabs

Render one content surface at a time. Do not render parsed conversation and raw bodies together.

1. **Summary**
   - Human-readable status, timing, cost, usage, entity/provider/model, URL/endpoint, project/service, tags, payload-capture state, and truncation state.
   - A short conversation or response preview is acceptable, but do not duplicate entire Input/Output tabs.

2. **Input**
   - LLM: system summary, ordered user/assistant history required for context, tool results, and current user input. Use role labels and readable wrapping.
   - API: method, redacted URL/query, request headers summary, and formatted request body.
   - Do not show transport headers above the actual user input.

3. **Output**
   - LLM: assistant text followed by tool calls. For streamed SSE, show the reconstructed assistant/tool-call result when extraction supports it; raw `event:`/`data:` frames belong only in Raw.
   - API: status, response headers summary, and response body.

4. **Metadata**
   - Request/response headers as aligned key/value rows, token breakdown, byte counts, timing, tags, stack/call site, IDs, and attribution facts.
   - Keep query-string redaction. Never reveal secrets that capture or current redaction rules hide.

5. **Raw**
   - Raw request body and raw response body/SSE, clearly separated and labelled.
   - Pretty-print JSON only when safe and bounded. Payloads are immutable, so memoize formatting by request ID/payload identity.
   - Never create JSX for a one-megabyte body on every one-second poll. Build a bounded or indexed line representation once and render only the visible slice.
   - If the UI intentionally limits a preview, state the exact amount omitted. Never silently clip at the current 2,000-character boundary.

### Scrolling and focus

- The detail body owns a `scrollTop`/cursor and renders only the rows that fit between fixed header and footer.
- `↑/↓` scroll one line; Page Up/Page Down scroll one viewport; Home/End move to boundaries.
- Switching tabs resets to the top of that tab or restores a per-tab scroll position; choose one behavior and test it. Per-tab restoration is preferred.
- Escape returns to the same tree row or originating request-list row.
- The footer must always describe the current tab and available actions.
- Very short terminals must degrade to a header plus at least three body rows and a footer; borders must never overlap content.

## Keyboard Model

Keep global `Tab` for switching burn0's main tabs. Do not create a conflict where focusing the workspace unexpectedly switches to API.

Recommended workspace bindings:

```text
↑/↓       move within focused pane
←/→       move focus between trace list, tree, and inspector in wide mode
h/l       collapse/expand tree branches
Enter     open/toggle the selected tree item or open full request detail
f         tree/flat mode where currently supported
Esc       close request detail or return one navigation level
Tab       switch burn0 main tabs
q         quit
```

Coordinate input ownership with `App` explicitly, using the existing sub-focus pattern or a clearer equivalent. When the LLM workspace owns left/right, `App` must not also switch tabs. Footer text changes with focus and mode; never display a dead key.

## Color and Visual Language

Color communicates type and state, not decoration:

- Orange: burn0 brand, active main tab, focused section/pane indicator, and rare primary emphasis.
- Green: known cost and success only when success needs explicit attention.
- Red: actual failure (`status >= 400`, network failure, tool error).
- Yellow: incomplete/unresolved/warning or relatively slow timing.
- LLM/tool/API colors may identify row type, but they must not turn selection into colored blocks.
- Dim gray: guides, timestamps, secondary metadata, headers, inactive pane selections.
- Main user/assistant content: terminal default/bright text for readability.

Use very few borders. The shell rules and pane dividers define structure. Avoid nested rounded cards in the inspector and request detail. Never rely on font sizes; hierarchy comes from placement, casing, bold, dim, whitespace, and restrained color.

## Implementation Guidance

1. Establish the viewport contract in `App` and pass available dimensions into screens.
2. Make `ui.tsx` fitting display-width safe. Reuse `visWidth`/`padCell` or `string-width`; do not maintain two competing implementations.
3. Replace minimum-width overflow with explicit responsive column sets. Width allocation must be a pure function.
4. Replace inverse selection with a continuous selected background and deterministic foreground treatment.
5. Make trace-list selection identity-based.
6. Extract reusable state/rendering from `TraceView` rather than duplicating tree behavior for wide mode.
7. Convert `TraceDetail` from an auto-height bordered card into an inspector body that can fill and scroll within a known rectangle.
8. Rebuild `DebugScreen` around fixed chrome, tabs, and a line viewport. Reuse `llm-io.ts`, token helpers, retention wording, and redaction.
9. Keep payload queries lazy. The wide inspector may query detail only for the selected request node; it must not issue one detail query per visible tree row.
10. Profile or reason about one-second polling. Parsing/pretty-printing an immutable payload must not repeat on every poll.

Do not change core database schema or capture behavior unless a proven blocker requires it. Do not add browser dependencies, logos, mouse-only actions, remote resources, or a second palette.

## Required Tests

Add regression tests that exercise the real shell as well as isolated pure functions.

### Width and alignment

- Render the LLM list and open trace inside `App`, not only standalone, at content boundary widths around 80, 90, 109, 110, 140, 159, 160, and 200 cells.
- Strip ANSI and assert every rendered line's `string-width` is at most the available content width.
- Assert pane widths plus dividers exactly equal the available width in two- and three-pane modes.
- Assert numeric column start positions are identical across root, nested trace, LLM, tool, API, fold, and selected rows.
- Assert optional headers and values disappear together; `TO…`, partially visible values, and wrapped rows are failures.
- Include CJK, emoji, combining-mark, and long endpoint/model fixtures.

### Selection and live data

- A selected row has one continuous neutral background, not inverse semantic-color blocks.
- Inserting a newer trace during polling does not change the selected trace identity unless the user is following the newest row.
- Tree cursor, folds, flat/tree mode, inspector scroll, and originating trace selection survive opening detail, escaping, and resizing across layout thresholds.

### Detail viewport

- A long conversation plus large request/response bodies never renders more rows than the content viewport.
- Every tab is reachable and scrollable to its final line.
- Borders/rules never intersect body text at short heights.
- Input and Output do not contain raw headers or SSE protocol frames unless the Raw tab is active.
- The same full request detail works when opened from LLM, API, Logs, and drill-down routes.
- Missing payload, expired payload, uncaptured payload, truncated capture, partial token reporting, and unpriced calls retain their existing truthful wording.
- Query-string secrets remain redacted.

### Performance and query behavior

- Selecting a request performs one lazy detail read; rendering a trace does not read every request payload.
- Immutable payload extraction/formatting is memoized and does not repeat on each trace poll.
- A large stored body renders only the visible line slice or a clearly labelled bounded preview.

Run at minimum:

```bash
pnpm --filter @burn0/cli test
pnpm --filter @burn0/cli build
pnpm test
```

## Completion Criteria

The work is complete only when all of the following are true:

- The small-width tree remains as readable as the current good screenshot.
- Medium width shows a correctly aligned tree and useful inspector without overflow.
- Wide width becomes a cohesive trace-list/tree/inspector workspace rather than an oversized tree beside a floating card.
- Selection is subdued and continuous—never orange/magenta/green/yellow blocks across one row.
- The request-detail screen has fixed chrome, distinct information tabs, a real viewport, and working scrolling.
- User and assistant content is immediately visible; raw headers, JSON, and SSE no longer dominate the default view.
- No content is hidden merely because the terminal uses an alternate screen.
- Every rendered line and pane obeys the available-width contract at tested boundaries.
- Existing trace semantics, privacy guarantees, and null/unknown handling remain intact.
