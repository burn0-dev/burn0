import { burn0, withTags } from '@burn0/core'
import { startVendors } from './start-vendors.mjs'

// Attribution demo: tags attach to every request inside the async context.
// Check the Debug screen — the tags line shows userId/feature/plan.
const llm = await startVendors()

await withTags({ userId: 'u_123', feature: 'chat' }, async () => {
  burn0.tag({ plan: 'pro' })
  await (await fetch(`${llm.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"gpt-4o","messages":[]}',
  })).json()
})

console.log('tagged call made — open Debug screen on it: tags {userId, feature, plan}')
llm.close()
