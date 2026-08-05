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
    for (const tc of asArray(m?.tool_calls)) {
      if (typeof tc?.id === 'string' && typeof tc?.function?.name === 'string') map.set(tc.id, tc.function.name)
    }
    for (const block of asArray(m?.content)) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        map.set(block.id, block.name)
      }
    }
  }
  return map
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
