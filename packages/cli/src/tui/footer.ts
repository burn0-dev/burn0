import { createContext, useContext, useEffect } from 'react'

/** The one footer line at the bottom of the screen. `App` renders exactly what
 *  this context last received — no per-tab lookup happens at render time
 *  there anymore. The active (sub)screen owns its own line by calling
 *  `useFooter(text)`; a screen that never calls it leaves App's own per-tab
 *  default in place (see `App.tsx`'s `FOOTERS`).
 *
 *  Shared here, not in `App.tsx`, because the natural call sites — `TraceView`
 *  nested inside `TraceListScreen` — would otherwise have to import `App.tsx`
 *  to reach it, and `App.tsx` imports `TraceListScreen` (which imports
 *  `TraceView`): a cycle. A leaf module both ends can import breaks it. */
export const FooterContext = createContext<(text: string | null) => void>(() => {})

/** Every footer's shared prefix: quit and tab navigation are live everywhere,
 *  so every per-screen string starts here rather than re-typing it five times
 *  with five chances to drift out of sync. */
export const NAV = 'q quit · tab/←→ screens'

/** Claim the footer line for as long as this component is mounted and `text`
 *  is a string. Pass `false` for a render where a component further down the
 *  tree is about to claim it instead (e.g. `TraceListScreen` while `TraceView`
 *  is open) — that skips the `setFooter` call entirely rather than clobbering
 *  what the child sets, which matters because passive effects fire child
 *  before parent within one commit: if both called `setFooter` with real text
 *  in the same commit, the parent's would win, backwards from what every
 *  caller here wants. */
export function useFooter(text: string | false): void {
  const setFooter = useContext(FooterContext)
  useEffect(() => {
    if (text === false) return
    setFooter(text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, setFooter])
  // Cleanup fires on unmount only (stable deps) — reverts App to its per-tab
  // default the instant this screen stops being the active one, without a
  // null flash on every ordinary text change (that would need this same
  // cleanup to also fire between text changes, which a single effect with
  // `text` in its deps would do).
  useEffect(() => () => setFooter(null), [setFooter])
}
