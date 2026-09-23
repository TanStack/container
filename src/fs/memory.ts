import { normalizePath } from './path'
import type { VirtualFileSystem } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class MemoryFileSystem implements VirtualFileSystem {
  readonly #files = new Map<string, Uint8Array>()

  constructor(initialFiles: Record<string, string | Uint8Array> = {}) {
    for (const [path, contents] of Object.entries(initialFiles)) {
      this.#files.set(
        normalizePath(path),
        typeof contents === 'string' ? encoder.encode(contents) : contents.slice(),
      )
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.#files.has(normalizePath(path))
  }

  async list(prefix = '/'): Promise<string[]> {
    const normalizedPrefix = normalizePath(prefix)
    return [...this.#files.keys()]
      .filter((path) => path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`) || normalizedPrefix === '/')
      .sort()
  }

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path)
    const contents = this.#files.get(normalized)
    if (!contents) throw new Error(`ENOENT: no such file, open '${normalized}'`)
    return contents.slice()
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path))
  }

  async writeFile(path: string, contents: Uint8Array): Promise<void> {
    this.#files.set(normalizePath(path), contents.slice())
  }

  async writeText(path: string, contents: string): Promise<void> {
    await this.writeFile(path, encoder.encode(contents))
  }
}
