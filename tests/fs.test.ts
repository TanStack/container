import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../src/fs/memory'
import { dirname, joinPath, normalizePath } from '../src/fs/path'
import { snapshotFileSystem } from '../src/fs/types'

describe('POSIX path operations', () => {
  it('normalizes relative, duplicate, and parent segments', () => {
    expect(normalizePath('src//routes/../server.ts')).toBe('/src/server.ts')
    expect(joinPath('/src/routes', '../server.ts')).toBe('/src/server.ts')
    expect(dirname('/src/server.ts')).toBe('/src')
  })
})

describe('MemoryFileSystem', () => {
  it('isolates byte buffers and returns deterministic snapshots', async () => {
    const original = new Uint8Array([65])
    const fs = new MemoryFileSystem({
      '/src/server.ts': 'export default {}',
      '/data/value.bin': original,
    })
    original[0] = 66

    const read = await fs.readFile('/data/value.bin')
    read[0] = 67

    expect(await fs.readFile('/data/value.bin')).toEqual(new Uint8Array([65]))
    expect(await fs.list('/src')).toEqual(['/src/server.ts'])
    expect(await snapshotFileSystem(fs)).toEqual({
      '/data/value.bin': 'A',
      '/src/server.ts': 'export default {}',
    })
  })

  it('reports missing files with a Node-shaped error', async () => {
    const fs = new MemoryFileSystem()
    await expect(fs.readText('/missing')).rejects.toThrow("ENOENT: no such file")
  })
})
