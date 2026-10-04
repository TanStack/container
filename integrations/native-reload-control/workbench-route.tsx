import * as React from 'react'
import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { WorkbenchControl } from '../../client'

export const Route = createFileRoute('/start/latest/docs/framework/react/examples/start-counter')({
  component: () => <ClientOnly><WorkbenchControl /></ClientOnly>,
})
