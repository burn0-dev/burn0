import { startVendors } from './start-vendors.mjs'

// Continuous traffic every 2s — for testing `burn0 watch` and the live
// Network screen in another terminal. Ctrl-C to stop.
const llm = await startVendors()
const paths = ['/v1/chat/completions', '/rest/v1/users/7', '/health', '/error']
let n = 0

console.log('generating one request every 2s — open `burn0 watch` or the Network tab. Ctrl-C stops.')
setInterval(async () => {
  const path = paths[n++ % paths.length]
  const init = path.startsWith('/v1/chat')
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-4o","messages":[]}' }
    : undefined
  try {
    await (await fetch(`${llm.base}${path}`, init)).text()
    console.log(`sent ${path}`)
  } catch {}
}, 2000)
