import { createServer } from 'node:http'

// The upstream vendors, deliberately run WITHOUT burn0 loaded and in their own
// process. Running them inside the instrumented app would be wrong twice over:
// burn0 would auto-root a trace for every inbound vendor request (they are real
// inbound requests to that process), and the demo would look like it had three
// times the traffic it has. Real vendors are remote; the demo should be too.

const TOOL_TURN = JSON.stringify({
  model: 'gpt-4o',
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_orders_1',
        type: 'function',
        function: { name: 'search_orders', arguments: '{"customer":"acme"}' },
      }],
    },
  }],
  usage: { prompt_tokens: 640, completion_tokens: 28 },
})

const COMPLETION = JSON.stringify({
  model: 'gpt-4o',
  choices: [{ message: { role: 'assistant', content: 'Your order shipped on Tuesday.' } }],
  usage: { prompt_tokens: 1204, completion_tokens: 380, prompt_tokens_details: { cached_tokens: 256 } },
})

// The parent kills this process when it is done; a half-written response to a
// closed socket is expected, not a failure.
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET')) return
  throw err
})

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  res.setHeader('content-type', 'application/json')

  if (path === '/declare-tool') return res.end(TOOL_TURN)
  if (path === '/v1/chat/completions') return res.end(COMPLETION)
  if (path === '/v1/chat/stream') {
    res.setHeader('content-type', 'text/event-stream')
    res.write('data: {"choices":[{"delta":{"content":"Your order "}}]}\n\n')
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"shipped."}}]}\n\n')
      res.write('data: {"usage":{"prompt_tokens":512,"completion_tokens":64}}\n\n')
      res.end('data: [DONE]\n\n')
    }, 120)
    return
  }
  if (path === '/error') {
    res.statusCode = 500
    return res.end('{"error":"boom"}')
  }
  res.end('{"ok":true}')
})

server.listen(0, () => {
  // the parent reads this line to learn the port
  process.stdout.write(`PORT ${server.address().port}\n`)
})
