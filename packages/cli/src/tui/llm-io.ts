// Best-effort extraction of the human-readable prompt and answer from stored
// LLM payloads (OpenAI / Anthropic / Gemini shapes, JSON or SSE). Returns null
// when a shape isn't recognized — callers hide the panel then.

export function extractPrompt(reqBody: string | null): string | null {
  if (!reqBody) return null
  let body: any
  try { body = JSON.parse(reqBody) } catch { return null }
  // OpenAI / Anthropic: messages[]
  if (Array.isArray(body?.messages)) {
    const lastUser = [...body.messages].reverse().find((m: any) => m?.role === 'user')
    if (lastUser) return contentToText(lastUser.content)
  }
  // Gemini: contents[].parts[].text
  if (Array.isArray(body?.contents)) {
    const lastUser = [...body.contents].reverse().find((c: any) => c?.role !== 'model')
    const text = lastUser?.parts?.map((p: any) => p?.text ?? '').join('')
    if (text) return text
  }
  if (typeof body?.prompt === 'string') return body.prompt
  return null
}

export function extractAnswer(resBody: string | null): string | null {
  if (!resBody) return null
  if (resBody.startsWith('data:') || resBody.includes('\ndata:')) return sseAnswer(resBody)
  let body: any
  try { body = JSON.parse(resBody) } catch { return null }
  // OpenAI
  const choice = body?.choices?.[0]
  if (choice?.message) return contentToText(choice.message.content)
  if (typeof choice?.text === 'string') return choice.text
  // Anthropic
  if (Array.isArray(body?.content)) {
    const text = body.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
    if (text) return text
  }
  // Gemini
  const parts = body?.candidates?.[0]?.content?.parts
  if (Array.isArray(parts)) {
    const text = parts.map((p: any) => p?.text ?? '').join('')
    if (text) return text
  }
  return null
}

function sseAnswer(raw: string): string | null {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    let chunk: any
    try { chunk = JSON.parse(line.slice(6)) } catch { continue }
    const openaiDelta = chunk?.choices?.[0]?.delta?.content
    if (typeof openaiDelta === 'string') out.push(openaiDelta)
    if (chunk?.type === 'content_block_delta' && typeof chunk?.delta?.text === 'string') out.push(chunk.delta.text)
  }
  return out.length ? out.join('') : null
}

function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
    return text || null
  }
  return null
}
