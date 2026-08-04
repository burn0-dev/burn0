import { startVendors } from './start-vendors.mjs'

// SSE streaming: app reads the stream chunk by chunk while burn0 tees it.
const llm = await startVendors()

const res = await fetch(`${llm.base}/v1/chat/stream`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
})

const reader = res.body.getReader()
const decoder = new TextDecoder()
process.stdout.write('app received stream: ')
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  process.stdout.write(decoder.decode(value).replace(/\n/g, ' '))
}
console.log('\nstream done — check LLM traces: tokens extracted from final SSE chunk')

// give burn0's async tee collection a moment to flush before exit
await new Promise((r) => setTimeout(r, 300))
llm.close()
