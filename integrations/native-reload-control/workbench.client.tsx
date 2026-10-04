import * as React from 'react'
import { ExampleNativeWorkbench } from '@control/workbench'
import { ThemeProvider } from '@control/theme'

// Match the Counter metadata, the real workbench still loads the unchanged
// pinned project through its existing endpoint and starts the installed SDK.
const definition = {
  id: 'start-react-start-counter',
  title: 'Start Counter',
  initialFile: '/src/routes/index.tsx',
  runtime: {
    type: 'webcontainer' as const,
    compatibility: 'tanstack-start-async-context' as const,
    install: { command: 'pnpm', args: ['install'] },
    start: { command: 'pnpm', args: ['run', 'dev'] },
  },
  workspace: { version: 1 as const, entry: '/src/routes/index.tsx', files: {} },
}

export function WorkbenchControl() {
  return <ThemeProvider><ExampleNativeWorkbench definition={definition} exampleId="start-counter" /></ThemeProvider>
}
