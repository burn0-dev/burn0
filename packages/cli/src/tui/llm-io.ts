// Shared conversation extraction from stored LLM request/response payloads
// (OpenAI / Anthropic — JSON or SSE; best-effort Gemini). One walker,
// `extractExchange`, feeds every screen that renders an LLM exchange.
// Returns raw ingredients (text, tool calls, tool results, counts) — callers
// decide capping, coloring and layout. Pure module: no Ink imports.
//
// The historic bug this replaces: `extractAnswer` returned null for a
// tool-call-only response (no text blocks), so a request that only ever
// called a tool rendered a totally empty detail panel (spec §8.1). Here,
// `assistantText` can be null while `toolCalls` is non-empty — the caller
// renders the calls instead of a blank card.
import { parseToolCalls, parseToolResults } from '@burn0/core'

export interface Exchange {
  parsed: boolean
  msgCount: number
  earlierCount: number
  systemFirstLine: string | null
  systemChars: number
  lastUserText: string | null
  toolResults: Array<{ name: string | null; isError: boolean; bytes: number }>
  assistantText: string | null
  toolCalls: Array<{ name: string; args: string | null }>
}

const SSE_START = /^\s*(data:|event:)/

export function extractExchange(reqBody: string | null, resBody: string | null): Exchange {
  const req = extractRequest(reqBody)
  const res = extractResponse(resBody)
  return {
    parsed: req.ok && res.ok,
    msgCount: req.msgCount,
    earlierCount: req.earlierCount,
    systemFirstLine: req.systemFirstLine,
    systemChars: req.systemChars,
    lastUserText: req.lastUserText,
    toolResults: req.toolResults,
    assistantText: res.assistantText,
    toolCalls: res.toolCalls,
  }
}

/** Thin wrapper kept for the Debug screen until it's rewritten (task 15). */
export function extractPrompt(reqBody: string | null): string | null {
  return extractExchange(reqBody, null).lastUserText
}

/** Thin wrapper kept for the Debug screen until it's rewritten (task 15).
 *  Carries the §8.1 fix through the old single-string API: a tool-call-only
 *  response renders its calls instead of coming back empty. */
export function extractAnswer(resBody: string | null): string | null {
  const ex = extractExchange(null, resBody)
  if (ex.assistantText != null) return ex.assistantText
  if (ex.toolCalls.length) {
    return ex.toolCalls.map((c) => `→ ${c.name}(${c.args ?? ''})`).join('\n')
  }
  return null
}

export interface TranscriptEntry {
  role: string
  text: string | null
  toolCalls?: Array<{ name: string; args: string | null }>
  toolResult?: { name: string | null; isError: boolean; bytes: number }
}

/** Every message the payload carries, in order — the full-text surface for
 *  the payload screen (task 15). `extractExchange`'s "last user text" /
 *  "final assistant turn" slices are the right shape for a fixed-height
 *  detail card; this screen scrolls and has no other place for single-pane
 *  users to read the whole conversation, so it walks every message instead
 *  of picking one.
 *
 *  Built on the same request/response internals as `extractExchange` — no
 *  parsing is duplicated here, only re-walked in message order. The response
 *  side is never part of `reqBody`'s `messages[]`, so its turn is appended
 *  last, independently, the same way `extractExchange.assistantText`/
 *  `toolCalls` are independent of the request side. */
export function extractTranscript(reqBody: string | null, resBody: string | null): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  if (reqBody != null) {
    let body: any
    try { body = JSON.parse(reqBody) } catch { body = null }
    if (Array.isArray(body?.messages)) {
      out.push(...messagesToTranscript(body, reqBody))
    } else if (body != null) {
      const text = requestFallbackText(body)
      if (text) out.push({ role: 'user', text })
    }
  }
  if (resBody != null) {
    const res = extractResponse(resBody)
    if (res.assistantText != null || res.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        text: res.assistantText,
        toolCalls: res.toolCalls.length ? res.toolCalls : undefined,
      })
    }
  }
  return out
}

/** Embeddings (`input`) / legacy completion (`prompt`) shaped bodies — same
 *  fallback `extractRequest` uses for `lastUserText`, kept here as the one
 *  other request shape worth a transcript entry. */
function requestFallbackText(body: any): string | null {
  if (typeof body?.input === 'string' || Array.isArray(body?.input)) return inputToText(body.input)
  if (typeof body?.prompt === 'string') return body.prompt || null
  return null
}

function messagesToTranscript(body: any, reqBody: string): TranscriptEntry[] {
  const messages: any[] = body.messages
  const out: TranscriptEntry[] = []
  const toolNames = collectToolNames(messages)
  // `parseToolResults` walks `messages` in this exact order, emitting one
  // entry per role:'tool' message and one per tool_result content block —
  // the same order this loop encounters them in, so consuming the flat list
  // sequentially reproduces the original per-message grouping without
  // re-deriving isError/bytes here.
  const results = parseToolResults(reqBody)
  let ri = 0

  // System prompt: same precedence as `fromMessages` (top-level string, then
  // top-level array, then a role:'system' message) — but shown as one
  // compact entry (first line + char count), never the full text. The
  // conversation itself gets the "full view"; a multi-KB system prompt does
  // not need to repeat here to be honest about what the payload carries.
  let systemIdx = -1
  let systemText: string | null = null
  if (typeof body.system === 'string') {
    systemText = body.system
  } else if (Array.isArray(body.system)) {
    const text = blocksToText(body.system)
    if (text) systemText = text
  } else {
    systemIdx = messages.findIndex((m) => m?.role === 'system')
    if (systemIdx !== -1) systemText = contentToText(messages[systemIdx].content) ?? ''
  }
  if (systemText != null) {
    out.push({ role: 'system', text: `${firstLine(systemText)}  (${systemText.length} chars)` })
  }

  messages.forEach((m, i) => {
    if (i === systemIdx) return
    if (m?.role === 'system') return // top-level system already shown once; skip a duplicate embedded copy

    if (m?.role === 'assistant') {
      const text = contentToText(m.content)
      const calls = toolCallsFromMessage(m).map((c) => ({ name: c.name, args: c.args }))
      if (text || calls.length) out.push({ role: 'assistant', text, toolCalls: calls.length ? calls : undefined })
      return
    }
    if (m?.role === 'tool' && typeof m.tool_call_id === 'string') {
      out.push(toolResultEntry(results[ri++], toolNames))
      return
    }
    if (m?.role === 'user') {
      const blocks = asArray(m.content)
      const resultBlocks = blocks.filter((b: any) => b?.type === 'tool_result')
      if (resultBlocks.length > 0) {
        for (let k = 0; k < resultBlocks.length; k++) out.push(toolResultEntry(results[ri++], toolNames))
        const text = blocksToText(blocks.filter((b: any) => b?.type !== 'tool_result'))
        if (text) out.push({ role: 'user', text })
        return
      }
      const text = contentToText(m.content)
      if (text) out.push({ role: 'user', text })
    }
  })

  return out
}

function toolResultEntry(
  r: { id: string; result: string | null; isError: boolean } | undefined,
  toolNames: Map<string, string>,
): TranscriptEntry {
  return {
    role: 'tool',
    text: null,
    toolResult: {
      name: r ? toolNames.get(r.id) ?? null : null,
      isError: r?.isError ?? false,
      bytes: Buffer.byteLength(r?.result ?? ''),
    },
  }
}

interface RequestExtract {
  ok: boolean
  msgCount: number
  earlierCount: number
  systemFirstLine: string | null
  systemChars: number
  lastUserText: string | null
  toolResults: Array<{ name: string | null; isError: boolean; bytes: number }>
}

function extractRequest(reqBody: string | null): RequestExtract {
  const empty: RequestExtract = {
    ok: true, msgCount: 0, earlierCount: 0,
    systemFirstLine: null, systemChars: 0, lastUserText: null, toolResults: [],
  }
  if (reqBody == null) return empty

  let body: any
  try { body = JSON.parse(reqBody) } catch { return { ...empty, ok: false } }

  if (Array.isArray(body?.messages)) return fromMessages(body, reqBody)
  if (Array.isArray(body?.contents)) return fromGeminiContents(body)
  if (typeof body?.input === 'string' || Array.isArray(body?.input)) {
    const text = inputToText(body.input)
    return { ...empty, lastUserText: text, msgCount: 1, earlierCount: text ? 0 : 1 }
  }
  if (typeof body?.prompt === 'string') {
    return { ...empty, lastUserText: body.prompt, msgCount: 1, earlierCount: 0 }
  }
  return empty
}

function fromMessages(body: any, reqBody: string): RequestExtract {
  const messages: any[] = body.messages
  const msgCount = messages.length
  const consumed = new Set<number>()

  // System prompt: Anthropic carries it top-level (doesn't occupy a messages[]
  // slot); OpenAI-style embeds a role:'system' message (does).
  let systemFirstLine: string | null = null
  let systemChars = 0
  if (typeof body.system === 'string') {
    systemChars = body.system.length
    systemFirstLine = firstLine(body.system)
  } else if (Array.isArray(body.system)) {
    const text = blocksToText(body.system)
    if (text) { systemChars = text.length; systemFirstLine = firstLine(text) }
  } else {
    const idx = messages.findIndex((m) => m?.role === 'system')
    if (idx !== -1) {
      const text = contentToText(messages[idx].content) ?? ''
      systemChars = text.length
      systemFirstLine = firstLine(text)
      consumed.add(idx)
    }
  }

  // Last real user text: scan backward for a user-role message whose content
  // resolves to non-empty text. Anthropic tool_result carriers are also
  // role:'user' but their blocks have no `.text`, so contentToText yields ''
  // for them and the scan keeps looking — no separate classification needed.
  let lastUserText: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue
    const text = contentToText(messages[i].content)
    if (text) { lastUserText = text; consumed.add(i); break }
  }

  // Tool results: reuse core's parsing (id/result/isError — including its
  // error-inference for the OpenAI shape, which has no explicit flag) and
  // resolve each id's name against every tool_use/tool_call the request's
  // assistant turns declared. Ids are unique per call, so a flat id→name map
  // built from all assistant messages is equivalent to "the previous
  // assistant message's declared calls" without positional guessing.
  const toolNames = collectToolNames(messages)
  const toolResults = parseToolResults(reqBody).map((r) => ({
    name: toolNames.get(r.id) ?? null,
    isError: r.isError,
    bytes: Buffer.byteLength(r.result ?? ''),
  }))
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role === 'tool') { consumed.add(i); continue }
    if (Array.isArray(m?.content) && m.content.some((b: any) => b?.type === 'tool_result')) consumed.add(i)
  }

  return {
    ok: true,
    msgCount,
    earlierCount: msgCount - consumed.size,
    systemFirstLine, systemChars,
    lastUserText,
    toolResults,
  }
}

function collectToolNames(messages: any[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    if (m?.role !== 'assistant') continue
    for (const c of toolCallsFromMessage(m)) map.set(c.id, c.name)
  }
  return map
}

/** OpenAI `tool_calls` / Anthropic `tool_use` blocks declared by ONE assistant
 *  message — the id+name+args a request-side turn carries. Not the same shape
 *  core's `parseToolCalls` reads (that walks a whole *response* envelope,
 *  `choices[0].message.tool_calls` / top-level `content[]`); this walks a bare
 *  message object out of `messages[]`, which is the one thing neither
 *  `collectToolNames` (id→name only) nor `parseToolCalls` (response-shaped)
 *  already provides. `collectToolNames` and `extractTranscript`'s assistant
 *  entries both build on this one extraction. */
function toolCallsFromMessage(m: any): Array<{ id: string; name: string; args: string | null }> {
  const out: Array<{ id: string; name: string; args: string | null }> = []
  for (const tc of asArray(m?.tool_calls)) {
    if (typeof tc?.id === 'string' && typeof tc?.function?.name === 'string') {
      const args = tc.function.arguments
      out.push({ id: tc.id, name: tc.function.name, args: typeof args === 'string' ? args : null })
    }
  }
  for (const block of asArray(m?.content)) {
    if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      out.push({ id: block.id, name: block.name, args: block.input != null ? JSON.stringify(block.input) : null })
    }
  }
  return out
}

/** Best-effort Gemini support: no top-level system slot, no tool parsing
 *  (core only covers OpenAI/Anthropic tool shapes) — just message counts and
 *  the last user turn. */
function fromGeminiContents(body: any): RequestExtract {
  const contents: any[] = body.contents
  const msgCount = contents.length
  let lastUserText: string | null = null
  let consumed = 0
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i]?.role === 'model') continue
    const text = asArray(contents[i]?.parts).map((p: any) => p?.text ?? '').join('')
    if (text) { lastUserText = text; consumed = 1; break }
  }
  return {
    ok: true, msgCount, earlierCount: msgCount - consumed,
    systemFirstLine: null, systemChars: 0, lastUserText, toolResults: [],
  }
}

function inputToText(input: unknown): string | null {
  if (typeof input === 'string') return input || null
  if (Array.isArray(input) && input.every((v) => typeof v === 'string')) {
    const text = input.join('\n')
    return text || null
  }
  return null
}

interface ResponseExtract {
  ok: boolean
  assistantText: string | null
  toolCalls: Array<{ name: string; args: string | null }>
}

function extractResponse(resBody: string | null): ResponseExtract {
  const toolCalls = parseToolCalls(resBody).map((c) => ({ name: c.name, args: c.args }))
  if (resBody == null) return { ok: true, assistantText: null, toolCalls }

  if (SSE_START.test(resBody)) {
    return { ok: true, assistantText: sseText(resBody), toolCalls }
  }
  let body: any
  try { body = JSON.parse(resBody) } catch { return { ok: false, assistantText: null, toolCalls } }
  return { ok: true, assistantText: jsonAssistantText(body), toolCalls }
}

function jsonAssistantText(body: any): string | null {
  const choice = body?.choices?.[0]
  if (choice?.message) {
    const text = contentToText(choice.message.content)
    if (text) return text
  }
  if (typeof choice?.text === 'string' && choice.text) return choice.text
  if (Array.isArray(body?.content)) {
    const text = body.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
    if (text) return text
  }
  const parts = body?.candidates?.[0]?.content?.parts
  if (Array.isArray(parts)) {
    const text = parts.map((p: any) => p?.text ?? '').join('')
    if (text) return text
  }
  return null
}

/** SSE text deltas only — never the raw `data:` line. Handles OpenAI
 *  `delta.content` and Anthropic `content_block_delta`/`text_delta`. Tool
 *  call deltas are handled separately by core's `parseToolCalls`. */
function sseText(raw: string): string | null {
  const out: string[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let chunk: any
    try { chunk = JSON.parse(payload) } catch { continue }
    const openaiDelta = chunk?.choices?.[0]?.delta?.content
    if (typeof openaiDelta === 'string') out.push(openaiDelta)
    if (chunk?.type === 'content_block_delta' && typeof chunk?.delta?.text === 'string') out.push(chunk.delta.text)
  }
  return out.length ? out.join('') : null
}

function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content || null
  if (Array.isArray(content)) return blocksToText(content) || null
  return null
}

function blocksToText(blocks: any[]): string {
  return blocks.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
}

function firstLine(s: string): string {
  const i = s.indexOf('\n')
  return i === -1 ? s : s.slice(0, i)
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : []
}
