import { startVendors } from './start-vendors.mjs'

// Mixed traffic: LLM-shaped calls (with a fake secret to see redaction),
// real public APIs (entity detection), and one error (error rate).
// out of process, so burn0 traces this script's outbound calls and not the
// mock server's inbound ones
const llm = await startVendors()

for (let i = 0; i < 3; i++) {
  await (await fetch(`${llm.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-demo-secret-key-12345' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: `question ${i}` }] }),
  })).json()
}

await (await fetch('https://api.github.com/repos/nodejs/node')).json()
await (await fetch('https://api.github.com/users/octocat/repos?per_page=2')).json()
await (await fetch(`${llm.base}/rest/v1/users/42/orders/1337`)).json() // endpoint normalization → :id
await fetch(`${llm.base}/error`) // 500 → error rate

console.log('demo done: 3 LLM + 2 GitHub + 1 normalized + 1 error call made')
console.log('now run:  pnpm burn0        (or: node ../cli/dist/index.mjs today)')
llm.close()
