import type { FileSnapshot } from '../fs/types'

export interface SerializedRequest {
  body?: ArrayBuffer
  headers: [string, string][]
  method: string
  url: string
}

export type HostToRuntimeMessage =
  | {
      type: 'load'
      id: number
      code: string
      env: Record<string, string>
      files: FileSnapshot
    }
  | {
      type: 'request'
      id: number
      request: SerializedRequest
    }

export type RuntimeToHostMessage =
  | { type: 'loaded'; id: number }
  | { type: 'response-start'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'response-chunk'; id: number; chunk: ArrayBuffer }
  | { type: 'response-end'; id: number }
  | { type: 'error'; id: number; message: string; stack?: string }

export interface RuntimeHost {
  asyncContext: {
    beginRequest(): void
    endRequest(): void
    retain(storage: { _store: unknown }, previous: unknown): boolean
  }
  env: Record<string, string>
  fs: {
    readFile(path: string | URL, options?: string | { encoding?: string }): Promise<string | Uint8Array>
    readdir(path: string | URL): Promise<string[]>
    stat(path: string | URL): Promise<{kind:'file'|'directory';isDirectory(): boolean;isFile(): boolean;size: number}>
    lstat(path: string | URL): Promise<{kind:'file'|'directory';isDirectory(): boolean;isFile(): boolean;size: number}>
    writeFile(path: string | URL, contents: string | Uint8Array): Promise<void>
  }
}

declare global {
  var __webContainerHost: RuntimeHost
}
