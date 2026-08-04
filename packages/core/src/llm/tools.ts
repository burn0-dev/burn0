/** Declared tool calls, and their results.
 *
 *  This half of §8 is *exact*: names, arguments, results and errors are all in
 *  payloads burn0 already stores. Only the attribution of downstream HTTP calls
 *  to a tool is inferred (§8.4). */

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string as the model produced it — not re-serialized. */
  args: string | null
}

export interface ToolResult {
  id: string
  result: string | null
  isError: boolean
}

/** Tool calls declared by an assistant response. Handles OpenAI `tool_calls`,
 *  Anthropic `tool_use` blocks, and both SSE delta forms (OpenAI `delta.tool_calls`, Anthropic `content_block_start`/`input_json_delta`). */
export function parseToolCalls(resBody: string | null): ToolCall[] {
  if (!resBody) return []
  try {
    const trimmed = resBody.trimStart()
    if (trimmed.startsWith('data:') || trimmed.startsWith('event:')) return fromSSE(resBody)
    return fromObject(JSON.parse(resBody))
  } catch {
    return []
  }
}

function fromObject(o: any): ToolCall[] {
  const out: ToolCall[] = []
  try {
    // OpenAI chat completions
    for (const choice of asArray(o?.choices)) {
      for (const tc of asArray(choice?.message?.tool_calls)) {
        const call = normalizeOpenAI(tc)
        if (call) out.push(call)
      }
    }
    // Anthropic messages: tool_use blocks sit beside text blocks
    for (const block of asArray(o?.content)) {
      if (block?.type !== 'tool_use') continue
      if (typeof block.id !== 'string' || typeof block.name !== 'string') continue
      out.push({ id: block.id, name: block.name, args: block.input != null ? JSON.stringify(block.input) : null })
    }
  } catch {}
  return out
}

function normalizeOpenAI(tc: any): ToolCall | null {
  if (typeof tc?.id !== 'string' || typeof tc?.function?.name !== 'string') return null
  const args = tc.function.arguments
  return { id: tc.id, name: tc.function.name, args: typeof args === 'string' ? args : null }
}

/** SSE delivers tool calls as deltas: the id and name arrive once, the arguments
 *  as partial JSON string fragments that must be concatenated in order. Only the
 *  `index` is present on every chunk, so it is the join key. */
function fromSSE(raw: string): ToolCall[] {
  const acc = new Map<number, { id: string | null; name: string | null; args: string }>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let chunk: any
    try { chunk = JSON.parse(payload) } catch { continue }
    for (const choice of asArray(chunk?.choices)) {
      for (const d of asArray(choice?.delta?.tool_calls)) {
        const i = typeof d?.index === 'number' ? d.index : 0
        const slot = acc.get(i) ?? { id: null, name: null, args: '' }
        if (typeof d?.id === 'string') slot.id = d.id
        if (typeof d?.function?.name === 'string') slot.name = d.function.name
        if (typeof d?.function?.arguments === 'string') slot.args += d.function.arguments
        acc.set(i, slot)
      }
    }
    // Anthropic stream: a tool_use block opens with its id and name in
    // content_block_start; the arguments arrive as input_json_delta fragments
    // that concatenate in order. `index` is shared with text blocks, but only
    // tool_use ever sets id+name, so the final filter drops text slots.
    if (chunk?.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
      const i = typeof chunk.index === 'number' ? chunk.index : 0
      acc.set(i, {
        id: typeof chunk.content_block.id === 'string' ? chunk.content_block.id : null,
        name: typeof chunk.content_block.name === 'string' ? chunk.content_block.name : null,
        args: '',
      })
    }
    if (chunk?.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta'
        && typeof chunk.delta.partial_json === 'string') {
      const i = typeof chunk.index === 'number' ? chunk.index : 0
      const slot = acc.get(i)
      if (slot) slot.args += chunk.delta.partial_json
    }
  }
  const out: ToolCall[] = []
  for (const [, slot] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.id || !slot.name) continue
    out.push({ id: slot.id, name: slot.name, args: slot.args || null })
  }
  return out
}

/** Tool results carried by the *next* request in the conversation. That request
 *  is the closing bracket of the tool's execution window (§8.4). */
export function parseToolResults(reqBody: string | null): ToolResult[] {
  if (!reqBody) return []
  const out: ToolResult[] = []
  try {
    const o = JSON.parse(reqBody)
    for (const m of asArray(o?.messages)) {
      // OpenAI: a flat message with role 'tool'
      if (m?.role === 'tool' && typeof m.tool_call_id === 'string') {
        const result = typeof m.content === 'string' ? m.content : m.content != null ? JSON.stringify(m.content) : null
        out.push({ id: m.tool_call_id, result, isError: looksLikeError(result) })
      }
      // Anthropic: tool_result blocks inside a user message
      for (const block of asArray(m?.content)) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const result = typeof block.content === 'string' ? block.content
          : block.content != null ? JSON.stringify(block.content) : null
        out.push({ id: block.tool_use_id, result, isError: block.is_error === true || looksLikeError(result) })
      }
    }
  } catch {}
  return out
}

/** Agents fail quietly: a tool returns an error, the model apologises in prose,
 *  and every HTTP call in the trace still returned 200. The provider only marks
 *  this explicitly on Anthropic, so the OpenAI shape is inferred from the body. */
function looksLikeError(result: string | null): boolean {
  if (!result) return false
  try {
    const o = JSON.parse(result)
    return !!(o && typeof o === 'object' && ('error' in o || o.ok === false || o.success === false))
  } catch {
    return false
  }
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : []
}
