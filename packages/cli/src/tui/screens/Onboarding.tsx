import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'

/** First-run screen — shown only when the WHOLE database is empty (unscoped
 *  count; an empty selected project is a different, scoped-empty state).
 *  Activation commands are troubleshooting info behind `?`, not a headline
 *  step: burn0 cannot observe a process it was not loaded into, and the happy
 *  path is simply "run your app". */
export function OnboardingScreen({ rows, columns }: { rows: number; columns: number }) {
  const [help, setHelp] = useState(false)

  useInput((input, key) => {
    if (input === '?') setHelp((h) => !h)
    if (key.escape) setHelp(false)
  })

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Box>
        <Text bold color={theme.accent}>burn0</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>Local API and LLM observability</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Box flexDirection="column" alignItems="flex-start">
          <Text bold color={theme.accent}>FIRST RUN</Text>
          <Text bold>Your API activity will appear here.</Text>
          <Text> </Text>
          <Text>burn0 watches outbound requests while your application runs.</Text>
          <Text>Everything stays on your machine—no account, proxy, or cloud dashboard.</Text>
          <Text> </Text>
          <Text>Run your application and make an API or LLM request.</Text>
          <Text>burn0 will refresh automatically when activity is captured.</Text>
          <Text> </Text>
          {help ? (
            <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
              <Text bold color={theme.accent}>SETUP</Text>
              <Text>Node.js: <Text color={theme.model}>import 'burn0'</Text></Text>
              <Text>Node.js: <Text color={theme.model}>node --import burn0/register app.js</Text></Text>
              <Text>Bun:     <Text color={theme.model}>bun --import burn0/register src/index.ts</Text></Text>
              <Text dimColor>? or esc to close</Text>
            </Box>
          ) : (
            <Text dimColor>Not seeing activity? Press ? for setup help.</Text>
          )}
        </Box>
      </Box>
      <Text dimColor>q quit · ? setup help</Text>
    </Box>
  )
}
