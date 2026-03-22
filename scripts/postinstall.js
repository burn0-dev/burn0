const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const projectRoot = process.env.INIT_CWD || process.cwd()

if (!process.stdout.isTTY) {
  console.log('[burn0] Run "npx burn0 init" to set up cost tracking.')
  process.exit(0)
}

try {
  const configPath = path.join(projectRoot, '.burn0', 'config.json')
  if (fs.existsSync(configPath)) {
    console.log('[burn0] Already configured. Run "npx burn0 init" to reconfigure.')
    process.exit(0)
  }
} catch {}

try {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli', 'index.js')
  execFileSync('node', [cliPath, 'init'], {
    stdio: 'inherit',
    cwd: projectRoot,
  })
} catch {
  console.log('[burn0] Setup skipped. Run "npx burn0 init" when ready.')
}
