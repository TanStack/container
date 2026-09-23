import { normalizePath } from './path'
import type { VirtualFileSystem } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class OpfsFileSystem implements VirtualFileSystem {
  readonly #root: Promise<FileSystemDirectoryHandle>

  constructor(namespace = 'web-container-spike') {
    this.#root = navigator.storage.getDirectory().then((storageRoot) =>
      storageRoot.getDirectoryHandle(namespace, { create: true }),
    )
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.#getFileHandle(path, false)
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return false
      throw error
    }
  }

  async list(prefix = '/'): Promise<string[]> {
    const normalized = normalizePath(prefix)
    const segments = this.#segments(normalized)
    let directory = await this.#root

    for (const segment of segments) {
      try {
        directory = await directory.getDirectoryHandle(segment)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return []
        throw error
      }
    }

    const files: string[] = []
    await this.#walk(directory, normalized === '/' ? '' : normalized, files)
    return files.sort()
  }

  async readFile(path: string): Promise<Uint8Array> {
    const handle = await this.#getFileHandle(path, false)
    return new Uint8Array(await (await handle.getFile()).arrayBuffer())
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path))
  }

  async writeFile(path: string, contents: Uint8Array): Promise<void> {
    const handle = await this.#getFileHandle(path, true)
    const writer = await handle.createWritable()
    await writer.write(contents as unknown as FileSystemWriteChunkType)
    await writer.close()
  }

  async writeText(path: string, contents: string): Promise<void> {
    await this.writeFile(path, encoder.encode(contents))
  }

  async #getFileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const segments = this.#segments(path)
    const filename = segments.pop()
    if (!filename) throw new Error('A file path is required')

    let directory = await this.#root
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create })
    }
    return directory.getFileHandle(filename, { create })
  }

  async #walk(
    directory: FileSystemDirectoryHandle,
    prefix: string,
    files: string[],
  ): Promise<void> {
    const entries = directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>
    }
    for await (const [name, handle] of entries.entries()) {
      const path = `${prefix}/${name}`
      if (handle.kind === 'file') files.push(normalizePath(path))
      else await this.#walk(handle as FileSystemDirectoryHandle, path, files)
    }
  }

  #segments(path: string): string[] {
    return normalizePath(path).split('/').filter(Boolean)
  }
}
