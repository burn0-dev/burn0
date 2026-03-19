import { describe, it, expect } from 'vitest'
import { teeReadableStream, extractUsageFromSSE } from '../../src/interceptor/stream'

describe('extractUsageFromSSE', () => {
  it('extracts usage from final SSE data chunk', () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]
    const usage = extractUsageFromSSE(chunks.join(''))
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 })
  })

  it('returns null when no usage in stream', () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    expect(extractUsageFromSSE(chunks.join(''))).toBeNull()
  })
})

describe('teeReadableStream', () => {
  it('produces two independent readable streams', async () => {
    const original = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'))
        controller.enqueue(new TextEncoder().encode('chunk2'))
        controller.close()
      },
    })

    const [s1, s2] = teeReadableStream(original)

    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const parts: string[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(new TextDecoder().decode(value))
      }
      return parts.join('')
    }

    const [r1, r2] = await Promise.all([read(s1), read(s2)])
    expect(r1).toBe('chunk1chunk2')
    expect(r2).toBe('chunk1chunk2')
  })
})
