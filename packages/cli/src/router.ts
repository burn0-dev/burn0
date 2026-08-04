export type Command =
  | { kind: 'tui' } | { kind: 'web' } | { kind: 'today' } | { kind: 'watch' }
  | { kind: 'export'; format: 'json' | 'csv'; out: string | null }
  | { kind: 'projects' } | { kind: 'init' } | { kind: 'help' }

/** Scope flags are global — they may appear before or after the subcommand, and
 *  must never be mistaken for one. */
const SCOPE_FLAGS = new Set(['--all', '--project', '--service'])

function stripScopeFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (!SCOPE_FLAGS.has(argv[i])) { out.push(argv[i]); continue }
    // --all is a bare switch; the other two consume a value when one is present
    if (argv[i] !== '--all' && argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1
  }
  return out
}

export function route(rawArgv: string[]): Command {
  const argv = stripScopeFlags(rawArgv)
  const [first] = argv
  if (!first || first === '--cli') return { kind: 'tui' }
  if (first === '--web') return { kind: 'web' }
  if (first === 'today') return { kind: 'today' }
  if (first === 'watch') return { kind: 'watch' }
  if (first === 'init') return { kind: 'init' }
  if (first === 'projects') return { kind: 'projects' }
  if (first === 'export') {
    const format = argv.includes('--csv') ? 'csv' as const : 'json' as const
    const outIdx = argv.indexOf('--out')
    return { kind: 'export', format, out: outIdx >= 0 ? argv[outIdx + 1] ?? null : null }
  }
  return { kind: 'help' }
}

export const HELP = `burn0 — local API & LLM usage tracker

Usage:
  burn0            open dashboard (terminal UI)
  burn0 --cli      terminal dashboard (explicit)
  burn0 --web      local web dashboard (coming soon)
  burn0 today      one-shot summary of today
  burn0 watch      live tail of requests
  burn0 export     dump metadata (--csv | --json, --out <file>)
  burn0 projects   list known projects
  burn0 init       write burn0.config.json with defaults

Scope (applies to every command above):
  --all              every project on this machine
  --project <name>   one named project
  --service <name>   one package within the project
                     default: the project the current directory belongs to
`
