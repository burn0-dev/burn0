export function teeReadableStream(
  stream: ReadableStream<Uint8Array>
): [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>] {
  return stream.tee() as [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>]
}

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
}

export function extractUsageFromSSE(raw: string): Usage | null {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    try {
      const parsed = JSON.parse(line.slice(6))
      if (parsed.usage) return parsed.usage
    } catch {}
  }
  return null
}

export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: string[] = []
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  return chunks.join('')
}
