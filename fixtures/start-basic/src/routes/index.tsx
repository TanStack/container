import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { useEffect, useState } from 'react'

const getRuntimeInfo = createServerFn({ method: 'GET' }).handler(async () => {
  await Promise.resolve()
  return {
    message: 'TanStack Start rendered inside the browser runtime.',
    pathname: new URL(getRequest().url).pathname,
  }
})

const callServer = createServerFn({ method: 'POST' }).handler(async () => {
  await Promise.resolve()
  const request = getRequest()
  return {
    method: request.method,
    pathname: new URL(request.url).pathname,
    origin: request.headers.get('Origin'),
    fetchSite: request.headers.get('Sec-Fetch-Site'),
    clonedOrigin: request.clone().headers.get('Origin'),
  }
})

export const Route = createFileRoute('/')({
  loader: () => getRuntimeInfo(),
  component: Home,
})

function Home() {
  const data = Route.useLoaderData()
  const [count, setCount] = useState(0)
  const [reply, setReply] = useState('')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <main data-hydrated={hydrated}>
      <h1>Bare-bones Start</h1>
      <p>{data.message}</p>
      <p style={{ overflowWrap: 'anywhere' }}>Request context: {data.pathname}</p>
      <button id="start-count" onClick={() => setCount((value) => value + 1)}>
        Count: {count}
      </button>
      <button
        id="server-call"
        onClick={async () => setReply(JSON.stringify(await callServer()))}
      >
        Call server
      </button>
      <output id="server-reply">{reply}</output>
      <p>
        <Link to="/about" id="about-link">
          About
        </Link>
      </p>
    </main>
  )
}
