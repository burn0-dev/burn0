export interface CollectResult { text: string; truncated: boolean }

export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<CollectResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  let truncated = false
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('stream timeout')), timeoutMs)
    timer.unref?.()
  })
  try {
    while (true) {
      const result = (await Promise.race([reader.read(), timeout])) as ReadableStreamReadResult<Uint8Array>
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes <= maxBytes + 65536) {
        chunks.push(decoder.decode(result.value, { stream: true }))
      } else {
        // keep draining past cap so tee's internal queue frees, but stop storing
        truncated = true
      }
    }
  } catch {
    // timeout / stream error: return what we have (partial), and cancel this
    // tee branch so it stops buffering chunks forever (doesn't affect the
    // other branch of the tee, which the app is still reading).
    truncated = true
    await reader.cancel().catch(() => {})
  } finally {
    if (timer) clearTimeout(timer)
    try { reader.releaseLock() } catch {}
  }
  return { text: chunks.join(''), truncated }
}
