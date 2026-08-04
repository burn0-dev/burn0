import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface ProjectIdentity {
  /** Stable identity. `path:<realpath>` normally; `name:<label>` when overridden. */
  key: string
  /** Display label. Collisions are allowed and disambiguated at render time. */
  name: string
  /** NULL for name-keyed projects — they are logical, not a place on disk. */
  rootPath: string | null
  gitRoot: string | null
}

/** A path only becomes an identity after normalization: without this a symlinked
 *  checkout splits one repo into two projects. The catch is not optional —
 *  `realpathSync` throws on a deleted directory, and nothing in capture-init may throw. */
function stableRoot(dir: string): string {
  try { return realpathSync.native(dir) } catch { return resolve(dir) }
}

/** Project = repo. The git root, not the nearest `package.json` — otherwise every
 *  package in a monorepo is its own project and the repo has no rollup. The
 *  package becomes `service` instead (see `resolveService`). */
export function resolveProject(cwd: string, override?: string): ProjectIdentity {
  const gitRoot = findUp(cwd, (dir) => existsSync(join(dir, '.git')))
  const pkgDir = findUp(cwd, (dir) => existsSync(join(dir, 'package.json')))
  const root = gitRoot ?? pkgDir ?? cwd

  if (override) {
    // Name-keyed is opt-in and *deliberately* merges: the same BURN0_PROJECT in
    // three repos is a statement that they are one project. rootPath stays NULL
    // so two repos sharing a name cannot flip-flop it on every process start.
    return { key: `name:${override}`, name: override, rootPath: null, gitRoot: gitRoot ? stableRoot(gitRoot) : null }
  }

  return {
    key: `path:${stableRoot(root)}`,
    name: pkgName(root) ?? basename(stableRoot(root)),
    rootPath: stableRoot(root),
    gitRoot: gitRoot ? stableRoot(gitRoot) : null,
  }
}

/** Service = the package within the repo. NULL in a single-package repo, where
 *  there is no sub-dimension to show and a Service column would be dead width. */
export function resolveService(cwd: string, projectRoot: string | null, override?: string): string | null {
  if (override) return override
  const pkgDir = findUp(cwd, (dir) => existsSync(join(dir, 'package.json')))
  if (!pkgDir) return null
  if (projectRoot && stableRoot(pkgDir) === stableRoot(projectRoot)) return null
  return pkgName(pkgDir) ?? basename(pkgDir)
}

function pkgName(dir: string): string | null {
  try {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
    return typeof name === 'string' && name.length > 0 ? name : null
  } catch {
    return null
  }
}

function findUp(from: string, pred: (dir: string) => boolean): string | null {
  let dir = from
  while (true) {
    if (pred(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
