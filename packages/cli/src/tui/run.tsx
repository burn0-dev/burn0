import React from 'react'
import { render } from 'ink'
import { App } from './App.js'
import { openReadDb } from '../db.js'

const ENTER_ALT_SCREEN = '\u001B[?1049h\u001B[H'
const EXIT_ALT_SCREEN = '\u001B[?1049l'

export function runTui(): void {
  const { db, scope } = openReadDb()

  // Take over the whole terminal like a real app (vim/htop style): render in
  // the alternate screen buffer, restore the user's scrollback on exit.
  const isTTY = process.stdout.isTTY
  if (isTTY) process.stdout.write(ENTER_ALT_SCREEN)
  let restored = false
  const restore = () => {
    if (restored || !isTTY) return
    restored = true
    try { process.stdout.write(EXIT_ALT_SCREEN) } catch {}
  }
  process.on('exit', restore)

  const { waitUntilExit } = render(<App db={db} scope={scope} />)
  waitUntilExit().then(restore, restore)
}
