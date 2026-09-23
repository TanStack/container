import { MemoryFileSystem } from './memory'
import { OpfsFileSystem } from './opfs'
import type { VirtualFileSystem } from './types'

export async function createProjectFileSystem(): Promise<VirtualFileSystem> {
  if (
    globalThis.isSecureContext &&
    typeof navigator.storage?.getDirectory === 'function'
  ) {
    const opfs = new OpfsFileSystem()
    try {
      await opfs.list()
      return opfs
    } catch {
      // WebKit exposes the API even when its backing store is unavailable.
    }
  }
  return new MemoryFileSystem()
}
