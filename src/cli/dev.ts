import { spawn } from 'node:child_process'
import path from 'node:path'

export async function runDev(command: string[]): Promise<void> {
  if (command.length === 0) {
    console.log('\n  Usage: burn0 dev -- node app.js\n')
    process.exit(1)
  }

  const registerPath = path.resolve(__dirname, '../register.js')
  const [cmd, ...args] = command

  if (cmd === 'node') {
    const child = spawn(cmd, ['--require', registerPath, ...args], {
      stdio: 'inherit',
      env: { ...process.env },
    })
    child.on('exit', (code) => process.exit(code ?? 0))
  } else {
    const nodeOptions = `--require ${registerPath} ${process.env.NODE_OPTIONS ?? ''}`
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: nodeOptions.trim() },
    })
    child.on('exit', (code) => process.exit(code ?? 0))
  }
}
