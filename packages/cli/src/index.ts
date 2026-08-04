import { route, HELP } from './router.js'

const cmd = route(process.argv.slice(2))

try {
  switch (cmd.kind) {
    case 'web':
      process.stderr.write('web dashboard coming soon — use burn0 --cli\n')
      process.exit(1)
    // eslint-disable-next-line no-fallthrough
    case 'help':
      process.stdout.write(HELP)
      process.exit(cmd.kind === 'help' ? 0 : 1)
    case 'today': {
      const { runToday } = await import('./commands/today.js')
      runToday()
      break
    }
    case 'export': {
      const { runExport } = await import('./commands/export.js')
      runExport(cmd.format, cmd.out)
      break
    }
    case 'projects': {
      const { runProjects } = await import('./commands/projects.js')
      runProjects()
      break
    }
    case 'init': {
      const { runInit } = await import('./commands/init.js')
      runInit()
      break
    }
    case 'watch': {
      const { runWatch } = await import('./commands/watch.js')
      runWatch()
      break
    }
    case 'tui': {
      const { runTui } = await import('./tui/run.js')
      runTui()
      break
    }
  }
} catch (err) {
  // Scope resolution reports its problems in prose (an ambiguous --project lists
  // the candidates); a stack trace would bury the part the user needs to read.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
