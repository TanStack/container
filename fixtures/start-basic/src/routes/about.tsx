import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({ component: About })

function About() {
  return (
    <main>
      <h1 id="about-title">Second route</h1>
      <Link to="/" id="home-link">
        Home
      </Link>
    </main>
  )
}
