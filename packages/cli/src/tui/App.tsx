import React, { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { usePoll, useTermSize } from './hooks.js'
import { theme } from './theme.js'
import { Rule } from './ui.js'
import { label, type ResolvedScope } from '../scope.js'
import { FooterContext, NAV } from './footer.js'
import type { TuiRoute } from './routes.js'
import { OverviewScreen } from './screens/Overview.js'
import { OnboardingScreen } from './screens/Onboarding.js'
import { EntityDetailScreen } from './screens/EntityDetail.js'
import { TargetDetailScreen } from './screens/TargetDetail.js'
import { UsageScreen } from './screens/Usage.js'
import { TracesScreen } from './screens/Traces.js'
import { TraceListScreen } from './screens/TraceList.js'
import { LogsScreen } from './screens/Logs.js'
import { DebugScreen } from './screens/Debug.js'

export const TABS = ['Overview', 'Usage', 'LLM', 'API', 'Logs'] as const

// Per-tab defaults — the fallback until (or unless) the active screen claims
// the line itself via `useFooter` (see `footer.ts`). Tabs 1/3/4 never
// claim, so their entries here ARE the permanent footer for those tabs.
// Tabs 0 and 2 claim the line in their own sub-states; their entries here
// only paint on the single pre-effect frame before the first claim lands.
const FOOTERS: Record<number, string> = {
  0: `${NAV} · ↓ focus`,
  1: `${NAV} · ↑↓ move · h/l/enter expand`,
  2: `${NAV} · ↑↓ select · enter open trace · f flat`,
  3: `${NAV} · ↑↓ select · enter open request`,
  4: `${NAV} · ↑↓ scroll · / filter · f follow · enter detail`,
}

const ALL_PROJECTS: ResolvedScope = {
  scope: { projectIds: null, services: null }, label: 'all projects', fellBack: false, projects: [],
}

/** The one authoritative content rectangle (workspace spec, layout contract):
 *  what remains inside App's paddingX={1} and between its rules. Screens size
 *  against THIS, never the raw terminal — the shell's cells are not theirs. */
export interface Viewport {
  columns: number
  rows: number
}

/** App's vertical chrome: header + rule + content marginTop + rule + footer. */
const CHROME_ROWS = 5

export function App({ db, scope: initial = ALL_PROJECTS, size }: {
  db: StorageDriver
  scope?: ResolvedScope
  /** Test seam — forces the terminal size the way TraceView tests force columns. */
  size?: { columns: number; rows: number }
}) {
  const { exit } = useApp()
  const [tab, setTab] = useState(0)
  // Overview → entity → target → request drill-down. `dashboard` is the tab
  // shell; everything else renders instead of it and Escape pops one level,
  // restoring the saved parent state (routes.ts).
  const [route, setRoute] = useState<TuiRoute>({ kind: 'dashboard' })
  // The window is view state shared by the whole drill-down: one source of
  // truth here, so a target screen queries the same window Overview shows.
  const [windowDays, setWindowDays] = useState<query.WindowDays>(30)
  const [subFocus, setSubFocus] = useState(false) // a screen widget holds ←→ (e.g. Overview window selector)
  // The one footer line an active (sub)screen can claim via `useFooter`
  // (footer.ts). Reset to null whenever the tab changes so a stale claim from
  // the screen being left can never survive onto the new one even for a tick.
  const [footerOverride, setFooterOverride] = useState<string | null>(null)
  // null = every project. Cycled by `p`; starts at whatever the CLI resolved.
  const [projectId, setProjectId] = useState<number | null>(initial.scope.projectIds?.[0] ?? null)
  const [service, setService] = useState<string | null>(initial.scope.services?.[0] ?? null)
  const term = useTermSize()
  const columns = size?.columns ?? term.columns
  const rows = size?.rows ?? term.rows
  const viewport: Viewport = { columns: columns - 2, rows: Math.max(3, rows - CHROME_ROWS) }

  const scope: Scope = { projectIds: projectId == null ? null : [projectId], services: service ? [service] : null }
  const stats = usePoll(() => query.dbStats(db, scope), 1000, [projectId, service])
  // First-run gating is UNSCOPED: an empty selected project inside a
  // populated database is a scoped-empty Overview, not a first run.
  const globalStats = usePoll(() => query.dbStats(db), 1000, [])
  // Services are a property of the *project*, not of the current service filter —
  // scoping this query by `service` would collapse the list to whatever is
  // already selected and make `s` a one-way trip.
  const services = usePoll(
    () => query.servicesFor(db, { projectIds: scope.projectIds, services: null }), 5000, [projectId])
  const projects = initial.projects

  const scopeLabel = projectId == null
    ? 'all projects'
    : label(projects.find((p) => p.id === projectId) ?? { name: `project ${projectId}` } as any, projects)

  const switchTab = (next: (t: number) => number) => {
    setSubFocus(false)
    setFooterOverride(null) // the screen being left clears its own claim on
    // unmount; this is the belt to that suspenders — a tab switch resets the
    // footer as well as any screen-local drill state.
    setTab(next)
  }

  // Escape pops exactly one level and rebuilds the parent route from the
  // saved return state — never a fresh, cursor-at-zero parent.
  const popRoute = () => {
    if (route.kind === 'request') setRoute(route.returnTo)
    else if (route.kind === 'target') {
      setRoute({
        kind: 'entity', entity: route.entity, entityClass: route.entityClass,
        restore: route.returnTo.entity, returnTo: route.returnTo.overview,
      })
    } else if (route.kind === 'entity') {
      setWindowDays(route.returnTo.windowDays)
      setRoute({ kind: 'dashboard', restore: route.returnTo })
    }
  }

  useInput((input, key) => {
    if (input === 'q') exit()
    if (route.kind !== 'dashboard') {
      if (key.escape) popRoute()
      return
    }
    if (key.tab) switchTab((t) => (t + 1) % TABS.length)
    // A dead keybind is worse than a missing one: `p` only exists with more than
    // one project, `s` only where the repo actually has several packages.
    if (input === 'p' && projects.length > 1) {
      const order: (number | null)[] = [null, ...projects.map((p) => p.id)]
      setProjectId(order[(order.indexOf(projectId) + 1) % order.length])
      setService(null)
    }
    if (input === 's' && services.length > 1) {
      const order: (string | null)[] = [null, ...services]
      setService(order[(order.indexOf(service) + 1) % order.length])
    }
    if (subFocus) return
    if (key.rightArrow) switchTab((t) => (t + 1) % TABS.length)
    if (key.leftArrow) switchTab((t) => (t + TABS.length - 1) % TABS.length)
  })

  if (globalStats.requestCount === 0) return <OnboardingScreen rows={rows} columns={columns} />

  const openDebug = (id: number) => setRoute({ kind: 'request', requestId: id, returnTo: { kind: 'dashboard' } })

  return (
    <FooterContext.Provider value={setFooterOverride}>
      <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
        <Box>
          <Text bold color={theme.accent}>burn0</Text>
          <Text dimColor> │ </Text>
          <Text color={theme.project}>{scopeLabel}{service ? ` · ${service}` : ''}</Text>
          <Text dimColor> │</Text>
          {TABS.map((t, i) => (
            <Text
              key={t}
              bold={i === tab}
              backgroundColor={i === tab && route.kind === 'dashboard' ? theme.accent : undefined}
              color={i === tab ? (route.kind === 'dashboard' ? theme.tabFg : theme.accent) : undefined}
              dimColor={i !== tab}
            > {t} </Text>
          ))}
          <Box flexGrow={1} justifyContent="flex-end">
            <Text dimColor>{`${stats.requestCount} reqs`}</Text>
          </Box>
        </Box>
        <Rule columns={columns - 2} />
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {route.kind === 'request' ? (
            <DebugScreen db={db} requestId={route.requestId} viewport={viewport} />
          ) : route.kind === 'entity' ? (
            <EntityDetailScreen
              db={db} scope={scope} windowDays={windowDays}
              entity={route.entity} entityClass={route.entityClass} restore={route.restore}
              onOpenTarget={(target, state) => setRoute({
                kind: 'target', entity: route.entity, entityClass: route.entityClass, target,
                returnTo: { entity: state, overview: route.returnTo },
              })}
            />
          ) : route.kind === 'target' ? (
            <TargetDetailScreen
              db={db} scope={scope} windowDays={windowDays}
              entity={route.entity} entityClass={route.entityClass} target={route.target}
              onOpenRequest={(id) => setRoute({ kind: 'request', requestId: id, returnTo: route })}
            />
          ) : (
            <>
              {tab === 0 && (
                <OverviewScreen
                  db={db} scope={scope} onSubFocus={setSubFocus}
                  windowDays={windowDays} onWindowChange={setWindowDays}
                  restore={route.restore}
                  onOpenEntity={(row, state) => setRoute({
                    kind: 'entity', entity: row.entity, entityClass: row.entityClass, returnTo: state,
                  })}
                />
              )}
              {tab === 1 && <UsageScreen db={db} scope={scope} />}
              {tab === 2 && (
                <TraceListScreen
                  db={db} scope={scope} viewport={viewport}
                  onSubFocus={setSubFocus} onOpenRequest={openDebug}
                />
              )}
              {tab === 3 && <TracesScreen db={db} scope={scope} llm={false} onOpen={openDebug} />}
              {tab === 4 && <LogsScreen db={db} scope={scope} onOpen={openDebug} />}
            </>
          )}
        </Box>
        <Rule columns={columns - 2} />
        <Box>
          {/* Exactly one footer line, always: the active screen's `useFooter`
             claim wins over this tab's static default; the request overlay's
             own claim (its tab bar keys) wins over the plain esc fallback. */}
          <Text dimColor>{route.kind === 'request'
            ? footerOverride ?? 'q quit · esc back'
            : `${footerOverride ?? FOOTERS[tab]}${projects.length > 1 && route.kind === 'dashboard' ? ' · p project' : ''}${services.length > 1 && route.kind === 'dashboard' ? ' · s service' : ''}`}</Text>
        </Box>
      </Box>
    </FooterContext.Provider>
  )
}
