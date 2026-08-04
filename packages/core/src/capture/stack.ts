const MAX_FRAMES = 5

export function captureStackSnippet(): string | null {
  try {
    const stack = new Error().stack
    if (!stack) return null
    const frames = stack.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) =>
        !l.includes('node:internal') &&
        !l.includes('node_modules') &&
        !/\/(src|dist)\/capture\//.test(l) &&
        !/\/(src|dist)\/(register|index)\./.test(l))
      .slice(0, MAX_FRAMES)
    return frames.length > 0 ? frames.join('\n') : null
  } catch {
    return null
  }
}
