import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Start the mock vendors in their own process, without burn0 loaded.
 *
 *  Running them inside the instrumented process would be wrong twice over:
 *  burn0 would auto-root a trace for every inbound vendor request — they *are*
 *  real inbound requests to that process — and the demo would appear to have
 *  several times the traffic it has. Real vendors are remote; the demo should be. */
export async function startVendors() {
  const script = fileURLToPath(new URL('./vendors.mjs', import.meta.url))
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vendors did not start')), 5000)
    child.stdout.on('data', (chunk) => {
      const m = /PORT (\d+)/.exec(String(chunk))
      if (!m) return
      clearTimeout(timer)
      resolve(Number(m[1]))
    })
  })
  return { base: `http://127.0.0.1:${port}`, close: () => child.kill() }
}
