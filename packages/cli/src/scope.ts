import { basename } from 'node:path'
import { query, resolveProject, type Scope, type StorageDriver, type ProjectSummary } from '@burn0/core'

export interface ScopeFlags {
  all: boolean
  project: string | null
  service: string | null
}

export interface ResolvedScope {
  scope: Scope
  /** What the header shows. */
  label: string
  /** True when the cwd matched no known project and the scope widened to all. */
  fellBack: boolean
  projects: ProjectSummary[]
}

export function parseScopeFlags(argv: string[]): ScopeFlags {
  return {
    all: argv.includes('--all'),
    project: flagValue(argv, '--project'),
    service: flagValue(argv, '--service'),
  }
}

/** A flag whose value is missing — or is itself a flag — has no value. Reading
 *  `argv[i+1]` blind turns `burn0 --project --all` into a project named "--all". */
function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag)
  if (i < 0) return null
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : null
}

export function resolveScope(db: StorageDriver, flags: ScopeFlags, cwd = process.cwd()): ResolvedScope {
  const all = query.projects(db)
  const services = flags.service ? [flags.service] : null
  const withService = (s: string) => (flags.service ? `${s} · ${flags.service}` : s)

  if (flags.all) {
    return { scope: { projectIds: null, services }, label: withService('all projects'), fellBack: false, projects: all }
  }

  if (flags.project) {
    const matches = all.filter((p) => p.name === flags.project || p.key === `name:${flags.project}`)
    if (matches.length === 0) {
      throw new Error(`no project named "${flags.project}" — run \`burn0 projects\` to list them`)
    }
    if (matches.length > 1) {
      const lines = matches.map((p) => `  ${p.name}  ${p.rootPath ?? '(logical)'}`).join('\n')
      throw new Error(`ambiguous project name "${flags.project}":\n${lines}\nrun burn0 from one of these directories, or use --all`)
    }
    return {
      scope: { projectIds: [matches[0].id], services },
      label: withService(label(matches[0], all)), fellBack: false, projects: all,
    }
  }

  // Default: whatever project this cwd belongs to.
  const here = all.find((p) => p.key === resolveProject(cwd).key)
  if (!here) {
    // D2: an unknown cwd widens rather than showing an empty screen.
    return { scope: { projectIds: null, services }, label: withService('all projects'), fellBack: true, projects: all }
  }
  return {
    scope: { projectIds: [here.id], services },
    label: withService(label(here, all)), fellBack: false, projects: all,
  }
}

/** Display-name collisions are cosmetic: group by name, and for any group larger
 *  than one append the checkout directory. Solo projects render bare.
 *
 *  Two repos can share both a package name *and* a directory name — `~/a/server`
 *  and `~/b/server` — so the qualified label is checked for uniqueness too, and
 *  falls through to the full path rather than printing the same label twice. */
export function label(p: ProjectSummary, all: ProjectSummary[]): string {
  const sameName = all.filter((o) => o.name === p.name)
  if (sameName.length < 2 || !p.rootPath) return p.name
  const short = (o: ProjectSummary) => `${o.name} (${basename(o.rootPath!)})`
  const withDir = sameName.filter((o) => o.rootPath)
  if (withDir.length === sameName.length && new Set(withDir.map(short)).size === sameName.length) {
    return short(p)
  }
  return `${p.name} (${p.rootPath})`
}
