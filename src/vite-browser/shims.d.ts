declare module '*.wasm' {
  const contents: Uint8Array
  export default contents
}

declare module 'process/browser' {
  const process: {
    argv: string[]
    browser: boolean
    chdir(directory: string): void
    cwd(): string
    env: Record<string, string | undefined>
    nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void
    platform: string
    version: string
    versions: Record<string, string>
  }
  export default process
}

declare module 'url' {
  const url: Record<string, (...args: unknown[]) => unknown>
  export default url
}

declare module 'path-browserify' {
  const path: {
    basename: typeof import('node:path').basename
    delimiter: string
    dirname: typeof import('node:path').dirname
    extname: typeof import('node:path').extname
    format: typeof import('node:path').format
    isAbsolute: typeof import('node:path').isAbsolute
    join: typeof import('node:path').join
    normalize: typeof import('node:path').normalize
    parse: typeof import('node:path').parse
    posix: typeof import('node:path').posix
    relative: typeof import('node:path').relative
    resolve: typeof import('node:path').resolve
    sep: string
  }
  export default path
}

declare module 'crypto-browserify'
declare module 'https-browserify'
declare module 'os-browserify/browser'
declare module 'stream-browserify'
declare module 'stream-http'
declare module 'browserify-zlib'
declare module 'assert'
declare module 'events'
declare module 'util'
declare module 'picomatch'

type BufferEncoding =
  | 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'ucs2' | 'ucs-2'
  | 'base64' | 'base64url' | 'latin1' | 'binary' | 'hex'

declare const __START_CLIENT_ENTRY__: string
declare const __START_SERVER_ENTRY__: string
declare const __START_INSTANCE_ENTRY__: string
