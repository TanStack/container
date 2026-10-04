import * as React from 'react'
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import stylesheet from '../../control.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Native workbench reload control' }],
    links: [{ rel: 'stylesheet', href: stylesheet }],
  }),
  component: Root,
})

function Root() {
  return <html><head><HeadContent /></head><body>
    <main style={{ maxWidth: 960, margin: '24px auto' }}><Outlet /></main>
    <Scripts />
  </body></html>
}
