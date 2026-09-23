import { afterEach, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { npmProject } from './fixtures/npm-project'
import { installProject } from '../src/npm/project'
import { WorkspaceFiles } from '../src/sandbox/files'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

for (const boundary of ['download', 'decompression'] as const) {
  test(`abort cancels stalled ${boundary} readers and preserves the workspace`, async () => {
    const fixture = npmProject()
    const fs = new WorkspaceFiles(fixture.files)
    const before = fs.snapshot()
    const close = vi.spyOn(WorkspaceFiles.prototype, 'close')
    const controller = new AbortController()
    const reason = new Error('user cancelled this install')
    const cancelled: unknown[] = []
    const streams: ReadableStream<Uint8Array>[] = []
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    function stalled() {
      const stream = new ReadableStream<Uint8Array>({
        start() { if (streams.length === 2) started() },
        cancel(value) {
          cancelled.push(value)
          // Source cleanup must not hold the install's mutation queue forever.
          return new Promise<void>(() => {})
        },
      })
      streams.push(stream)
      return stream
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      boundary === 'download' ? stalled() : Uint8Array.from(fixture.archives[url]),
    )))
    if (boundary === 'decompression') {
      vi.stubGlobal('DecompressionStream', class {
        readable = stalled()
        writable = new WritableStream()
      })
    }
    const install = installProject(fs, {}, controller.signal)
    const rejected = expect(install).rejects.toBe(reason)
    await ready
    controller.abort(reason)
    await rejected
    expect(cancelled).toEqual([reason, reason, reason])
    expect(streams.every(stream => !stream.locked)).toBe(true)
    expect(fs.snapshot()).toEqual(before)
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.contexts[0]).not.toBe(fs)
    fs.close()
  })
}

test('normal gzip archives still install', async () => {
  const fixture = npmProject()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(Uint8Array.from(fixture.archives[url]))))
  const fs = new WorkspaceFiles(fixture.files)
  expect(await installProject(fs)).toMatchObject({ installed: 3 })
  fs.close()
})

test('malformed gzip rejects without changing the workspace', async () => {
  const fixture = npmProject()
  const bytes = new TextEncoder().encode('not gzip')
  for (const pkg of Object.values(fixture.lock.packages)) {
    if (pkg.resolved) pkg.integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  }
  fixture.files['/package-lock.json'] = JSON.stringify(fixture.lock)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)))
  const fs = new WorkspaceFiles(fixture.files), before = fs.snapshot()
  await expect(installProject(fs)).rejects.toThrow()
  expect(fs.snapshot()).toEqual(before)
  fs.close()
})

for (const boundary of ['download', 'decompression'] as const) {
  test(`${boundary} byte limit cancels the source without waiting for stalled cleanup`, async () => {
    const fixture = npmProject()
    const cancelled = vi.fn(() => new Promise<void>(() => {}))
    function oversized() {
      return new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array((boundary === 'download' ? 16 : 64) * 1024 * 1024 + 1)) },
        cancel: cancelled,
      })
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      boundary === 'download' ? oversized() : Uint8Array.from(fixture.archives[url]),
    )))
    if (boundary === 'decompression') vi.stubGlobal('DecompressionStream', class {
      readable = oversized()
      writable = new WritableStream()
    })
    const fs = new WorkspaceFiles(fixture.files), before = fs.snapshot()
    await expect(installProject(fs)).rejects.toThrow('Package exceeds download or extraction limit')
    expect(cancelled).toHaveBeenCalled()
    expect(fs.snapshot()).toEqual(before)
    fs.close()
  })
}
