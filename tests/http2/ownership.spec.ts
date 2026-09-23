import { test, expect } from '@playwright/test'
test.skip(process.env.HTTP2_OWNED !== '1', 'Owned HTTP/2 runtime only')

test('sessions share an owner budget without sharing protocol state or authority', async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const path = '/src/sandbox/http2-backend.ts'
    const { HTTP2Backend } = await import(/* @vite-ignore */ path)
    const backend = new HTTP2Backend(undefined, 2)
    await backend.createOwner(1); await backend.createOwner(2)
    const pairs = [1, 2].map(owner => ({ owner, client: backend.open(owner), server: backend.open(owner, true) }))
    const denied: string[] = []
    const victim = pairs[0].client
    for (const action of [
      () => backend.send(2, victim), () => backend.feed(2, victim, new Uint8Array()),
      () => backend.events(2, victim), () => backend.request(2, victim),
      () => backend.respond(2, victim, 1), () => backend.write(2, victim, 1, new Uint8Array()),
      () => backend.consume(2, victim, 1, 1), () => backend.reset(2, victim, 1),
      () => backend.queued(2, victim, 1), () => backend.destroy(2, victim),
    ]) { try { action(); denied.push('allowed') } catch (error) { denied.push((error as { code: string }).code) } }
    const received: Record<number, number[]> = { 1: [], 2: [] }
    for (const pair of pairs) {
      const stream = backend.request(pair.owner, pair.client, 'POST', `/owner-${pair.owner}`)
      backend.write(pair.owner, pair.client, stream, new Uint8Array([pair.owner, 42]), true)
    }
    // Interleave sessions whose stream IDs are both 1, including peers in the same module.
    for (let i = 0; i < 1000; i++) {
      let moved = 0
      for (const pair of pairs) {
        const bytes = backend.send(pair.owner, pair.client, 13); moved += bytes.length
        if (bytes.length) backend.feed(pair.owner, pair.server, bytes)
        for (const event of backend.events(pair.owner, pair.server)) {
          if (event.type === 2) { received[pair.owner].push(...event.bytes); backend.consume(pair.owner, pair.server, event.stream, event.bytes.length) }
        }
      }
      if (!moved) break
    }
    const before = backend.stats(2)
    await backend.closeOwner(1)
    await backend.createOwner(1)
    const replacement = backend.open(1)
    let stale = ''
    try { backend.send(1, victim) } catch (error) { stale = (error as { code: string }).code }
    const survivor = pairs[1]
    backend.respond(2, survivor.server, 1)
    backend.write(2, survivor.server, 1, new Uint8Array([7, 8, 9]), true)
    const response: number[] = []
    for (let i = 0; i < 1000; i++) {
      const bytes = backend.send(2, survivor.server, 13)
      if (!bytes.length) break
      backend.feed(2, survivor.client, bytes)
      for (const event of backend.events(2, survivor.client)) if (event.type === 2) { response.push(...event.bytes); backend.consume(2, survivor.client, event.stream, event.bytes.length) }
    }
    backend.destroy(2, survivor.client); backend.destroy(2, survivor.server)
    const after = backend.stats(2)
    await backend.closeOwner(1); await backend.closeOwner(2)
    return { denied, stale, replacement, victim, received, response, before, after }
  })
  expect(result.denied).toEqual(Array(10).fill('EBADF'))
  expect(result.stale).toBe('EBADF')
  expect(result.replacement).not.toBe(result.victim)
  expect(result.received).toEqual({ 1: [1, 42], 2: [2, 42] })
  expect(result.response).toEqual([7, 8, 9])
  expect(result.before.sessions).toBe(2)
  expect(result.after.sessions).toBe(0)
  expect(result.after.allocated).toBeLessThan(result.before.allocated)
})

test('invalid arguments and a failed peer leave other sessions usable', async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const path = '/src/sandbox/http2-backend.ts'
    const { HTTP2Backend } = await import(/* @vite-ignore */ path)
    const backend = new HTTP2Backend()
    await backend.createOwner(1)
    const client = backend.open(1), broken = backend.open(1, true)
    const errors: string[] = []
    for (const action of [
      () => backend.request(1, client, 'POST', '/bad\0path'),
      () => backend.write(1, client, -1, new Uint8Array()),
      () => backend.write(1, client, 1, new Uint8Array(65537)),
      () => backend.send(1, client, -1),
      () => backend.consume(1, client, 1, -1),
      () => backend.respond(1, client, 1, 999),
    ]) { try { action(); errors.push('allowed') } catch (error) { errors.push((error as { code: string }).code) } }
    let protocol = '', failed = '', stale = ''
    try { backend.feed(1, broken, new TextEncoder().encode('not an HTTP/2 preface')) } catch (error) { protocol = (error as { code: string }).code }
    try { backend.send(1, broken) } catch (error) { failed = (error as { code: string }).code }
    backend.destroy(1, broken)
    try { backend.events(1, broken) } catch (error) { stale = (error as { code: string }).code }
    const stream = backend.request(1, client)
    backend.write(1, client, stream, new Uint8Array([42]), true)
    const sent = backend.send(1, client).length
    await backend.closeOwner(1)
    return { errors, protocol, failed, stale, sent }
  })
  expect(result.errors).toEqual(Array(6).fill('EINVAL'))
  expect(result.protocol).toBe('ERR_HTTP2_BACKEND')
  expect(result.failed).toBe('ERR_HTTP2_SESSION_ERROR')
  expect(result.stale).toBe('EBADF')
  expect(result.sent).toBeGreaterThan(0)
})

test('closing a loading owner retains its slot until initialization settles', async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const path = '/src/sandbox/http2-backend.ts'
    const { HTTP2Backend, loadHTTP2Factory } = await import(/* @vite-ignore */ path)
    const create = await loadHTTP2Factory()
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    const backend = new HTTP2Backend(async () => { await gate; return create() }, 1)
    const opening = backend.createOwner(1).then(() => '', (error: { code: string }) => error.code)
    const closing = backend.closeOwner(1)
    const whileClosing = await backend.createOwner(2).then(() => '', (error: { code: string }) => error.code)
    resume(); await closing
    const cancelled = await opening
    await backend.createOwner(2)
    const count = backend.stats(2).sessions
    await backend.closeOwner(2)
    return { whileClosing, cancelled, count }
  })
  expect(result).toEqual({ whileClosing: 'EMFILE', cancelled: 'ECANCELED', count: 0 })
})

test('session caps and aggregate memory limits recover with synchronous setup', async ({ page }) => {
  await page.goto('/sandbox.html')
  const result = await page.evaluate(async () => {
    const path = '/src/sandbox/http2-backend.ts'
    const { HTTP2Backend, loadHTTP2Factory } = await import(/* @vite-ignore */ path)
    const create = await loadHTTP2Factory(), backend = new HTTP2Backend(create, 2, create)
    let initial = '', cap = '', quota = ''
    try { backend.createOwnerSync(1, { maxBytes: 65536 }) } catch (error) { initial = (error as { code: string }).code }
    backend.createOwnerSync(1, { maxSessions: 2 })
    const a = backend.open(1); backend.open(1)
    try { backend.open(1) } catch (error) { cap = (error as { code: string }).code }
    backend.destroy(1, a); const b = backend.open(1)
    backend.createOwnerSync(2, { maxBytes: 196608 })
    const sessions: number[] = []
    for (let i = 0; i < 32; i++) {
      try { sessions.push(backend.open(2)) } catch (error) { quota = (error as { code: string }).code; break }
    }
    const stats = backend.stats(2)
    backend.destroy(2, sessions[0]); const recovered = backend.open(2)
    await backend.closeOwner(1); await backend.closeOwner(2)
    return { initial, cap, quota, stats, count: sessions.length, recovered, replaced: a !== b }
  })
  expect(result.initial).toBe('ERR_RESOURCE_LIMIT')
  expect(result.cap).toBe('ERR_RESOURCE_LIMIT')
  expect(result.quota).toBe('ERR_RESOURCE_LIMIT')
  expect(result.count).toBeGreaterThan(0)
  expect(result.count).toBeLessThan(32)
  expect(result.stats.peak).toBeLessThanOrEqual(result.stats.maxBytes)
  expect(result.replaced).toBe(true)
  expect(result.recovered).toBeGreaterThan(0)
})
