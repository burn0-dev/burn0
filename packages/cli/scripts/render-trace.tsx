// Renders TraceView headlessly for a given DB + trace id and prints the frame.
// The Task 12 visual-checkpoint harness (spec §8): what this prints is what
// Ink draws, so the frame is evidence, not a mockup.
// Usage: npx tsx scripts/render-trace.tsx <dbPath> [traceId|''] [columns]
import React from 'react'
import { render } from 'ink-testing-library'
import { openDatabase, query } from '@burn0/core'
import { TraceView } from '../src/tui/screens/TraceView.js'

const [dbPath, idArg, colsArg] = process.argv.slice(2)
const db = openDatabase(dbPath)
const traceId = idArg ? Number(idArg)
  : (query.traceList(db, { projectIds: null, services: null }, {})[0]?.id ?? 0)
const { lastFrame } = render(
  <TraceView db={db} traceId={traceId} columns={Number(colsArg ?? 140)}
    onBack={() => {}} onOpenRequest={() => {}} />)
await new Promise((r) => setTimeout(r, 150))
console.log(lastFrame())
process.exit(0)
