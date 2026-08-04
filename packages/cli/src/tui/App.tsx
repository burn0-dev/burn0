import React, { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { query, type Scope, type StorageDriver } from '@burn0/core'
import { usePoll, useTermSize } from './hooks.js'
import { theme } from './theme.js'
import { Rule } from './ui.js'
import { label, type ResolvedScope } from '../scope.js'
import { OverviewScreen } from './screens/Overview.js'
import { UsageScreen } from './screens/Usage.js'
import { TracesScreen } from './screens/Traces.js'
import { TraceListScreen } from './screens/TraceList.js'
import { LogsScreen } from './screens/Logs.js'
import { DebugScreen } from './screens/Debug.js'

export const TABS = ['Overview', 'Usage', 'LLM', 'API', 'Logs'] as const

const NAV = 'q quit · tab/←→ screens'
// Per-tab, because the keys genuinely differ — a footer that lists keys the
// current screen ignores is worse than no footer.
const FOOTERS: Record<number, string> = {
  0: `${NAV} · ↓ window`,
  1: `${NAV} · ↑↓ move · h/l/enter expand`,
  2: `${NAV} · ↑↓ select · enter open trace · f flat`,
  3: `${NAV} · ↑↓ select · enter open request`,
  4: `${NAV} · ↑↓ scroll · / filter · f follow · enter detail`,
}

const ALL_PROJECTS: ResolvedScope = {
  scope: { projectIds: null, services: null }, label: 'all projects', fellBack: false, projects: [],
}

export function App({ db, scope: initial = ALL_PROJECTS }: { db: StorageDriver; scope?: ResolvedScope }) {
  const { exit } = useApp()
  const [tab, setTab] = useState(0)
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null)
  const [subFocus, setSubFocus] = useState(false) // a screen widget holds ←→ (e.g. Overview window selector)
  // null = every project. Cycled by `p`; starts at whatever the CLI resolved.
  const [projectId, setProjectId] = useState<number | null>(initial.scope.projectIds?.[0] ?? null)
  const [service, setService] = useState<string | null>(initial.scope.services?.[0] ?? null)
  const { columns, rows } = useTermSize()

  const scope: Scope = { projectIds: projectId == null ? null : [projectId], services: service ? [service] : null }
  const stats = usePoll(() => query.dbStats(db, scope), 1000, [projectId, service])
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
    setTab(next)
  }

  useInput((input, key) => {
    if (input === 'q') exit()
    if (selectedRequestId != null) {
      if (key.escape) setSelectedRequestId(null)
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

  if (stats.requestCount === 0) return <Onboarding rows={rows} columns={columns} />

  const openDebug = (id: number) => setSelectedRequestId(id)

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Box>
        <Text bold color={theme.accent}>burn0</Text>
        <Text dimColor> │ </Text>
        <Text color={theme.model}>{scopeLabel}{service ? ` · ${service}` : ''}</Text>
        <Text dimColor> │</Text>
        {TABS.map((t, i) => (
          <Text
            key={t}
            inverse={i === tab && selectedRequestId == null}
            bold={i === tab}
            color={i === tab ? theme.accent : undefined}
            dimColor={i !== tab}
          > {t} </Text>
        ))}
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>{`${stats.requestCount} reqs`}</Text>
        </Box>
      </Box>
      <Rule columns={columns - 2} />
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {selectedRequestId != null ? (
          <DebugScreen db={db} requestId={selectedRequestId} />
        ) : (
          <>
            {tab === 0 && <OverviewScreen db={db} scope={scope} onSubFocus={setSubFocus} />}
            {tab === 1 && <UsageScreen db={db} scope={scope} />}
            {tab === 2 && <TraceListScreen db={db} scope={scope} onOpenRequest={openDebug} />}
            {tab === 3 && <TracesScreen db={db} scope={scope} llm={false} onOpen={openDebug} />}
            {tab === 4 && <LogsScreen db={db} scope={scope} onOpen={openDebug} />}
          </>
        )}
      </Box>
      <Rule columns={columns - 2} />
      <Box>
        <Text dimColor>{selectedRequestId != null
          ? 'q quit · esc back'
          : `${FOOTERS[tab]}${projects.length > 1 ? ' · p project' : ''}${services.length > 1 ? ' · s service' : ''}`}</Text>
      </Box>
    </Box>
  )
}

function Onboarding({ rows, columns }: { rows: number; columns: number }) {
  return (
    <Box flexDirection="column" width={columns} height={rows} padding={1}>
      <Text bold color={theme.accent}>burn0</Text>
      <Text bold> No requests captured yet</Text>
      <Text> </Text>
      <Text>1. npm install burn0</Text>
      <Text>2. Add to the top of your entry file:   <Text color={theme.model}>import 'burn0'</Text></Text>
      <Text dimColor>   (or run:  node --import burn0/register app.js)</Text>
      <Text>3. Run your app, make some API calls, then reopen burn0.</Text>
    </Box>
  )
}
