import { fs, vol } from 'memfs'
import { Buffer } from 'buffer'

function bind<T extends (...args: never[]) => unknown>(method: T): T {
  return method.bind(fs) as T
}

export const access = bind(fs.access)
export const accessSync = bind(fs.accessSync)
export const appendFile = bind(fs.appendFile)
export const chmod = bind(fs.chmod)
export const close = bind(fs.close)
export const copyFile = bind(fs.copyFile)
export const cp = bind(fs.cp)
export const createReadStream = bind(fs.createReadStream)
export const createWriteStream = bind(fs.createWriteStream)
export const exists = bind(fs.exists)
export const existsSync = bind(fs.existsSync)
export const fstat = bind(fs.fstat)
export const lstat = bind(fs.lstat)
export const lstatSync = bind(fs.lstatSync)
export const mkdir = bind(fs.mkdir)
export const mkdirSync = bind(fs.mkdirSync)
export const mkdtemp = bind(fs.mkdtemp)
export const open = bind(fs.open)
export const read = bind(fs.read)
export const readdir = bind(fs.readdir)
export const readdirSync = bind(fs.readdirSync)
export const readFile = bind(fs.readFile)
export const readlink = bind(fs.readlink)
export const readlinkSync = bind(fs.readlinkSync)
export const realpath = bind(fs.realpath)
export const rename = bind(fs.rename)
export const rm = bind(fs.rm)
export const rmdir = bind(fs.rmdir)
export const stat = bind(fs.stat)
export const statSync = bind(fs.statSync)
export const symlink = bind(fs.symlink)
export const unlink = bind(fs.unlink)
export const utimes = bind(fs.utimes)
export const watch = bind(fs.watch)
export const watchFile = bind(fs.watchFile)
export const unwatchFile = bind(fs.unwatchFile)
export const write = bind(fs.write)
export const writeFile = bind(fs.writeFile)
export const writeFileSync = bind(fs.writeFileSync)
export const constants = fs.constants
export const promises = fs.promises
export const Stats = fs.Stats

export function readFileSync(path: unknown, options?: unknown): unknown {
  if (path instanceof URL) {
    if (path.pathname.endsWith('/package.json')) {
      const contents = Buffer.from('{"name":"rollup","version":"4.62.4"}')
      return options ? contents.toString('utf8') : contents
    }
    if (path.protocol === 'file:') path = decodeURIComponent(path.pathname)
  }
  if (String(path).endsWith('bindings_wasm_bg.wasm')) {
    const bytes = (globalThis as typeof globalThis & { __rollupWasmBytes?: Uint8Array }).__rollupWasmBytes
    if (!bytes) throw new Error('Rollup WASM was not initialized')
    const encoding = typeof options === 'string'
      ? options
      : (options as { encoding?: string } | undefined)?.encoding
    return encoding ? Buffer.from(bytes).toString(encoding as never) : Buffer.from(bytes)
  }
  return fs.readFileSync(path as never, options as never)
}

export const realpathSync = Object.assign(bind(fs.realpathSync), {
  native: bind(fs.realpathSync),
})

export function resetVolume(files: Record<string, string | Uint8Array>): void {
  vol.reset()
  fs.mkdirSync('/app', { recursive: true })
  fs.mkdirSync('/dist/client', { recursive: true })
  fs.writeFileSync('/dist/client/client.mjs', '')
  fs.writeFileSync('/dist/client/env.mjs', '')
  for (const [path, contents] of Object.entries(files)) {
    const normalized = path.startsWith('/') ? path : `/app/${path}`
    fs.mkdirSync(normalized.slice(0, normalized.lastIndexOf('/')) || '/', { recursive: true })
    fs.writeFileSync(normalized, contents)
  }
}

export function readVolume(prefix = '/app'): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {}
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (typeof entry !== 'object' || !('name' in entry) || !('isDirectory' in entry)) {
        throw new Error('Expected a directory entry from memfs')
      }
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) visit(path)
      else result[path] = Uint8Array.from(fs.readFileSync(path) as Uint8Array)
    }
  }
  if (fs.existsSync(prefix)) visit(prefix)
  return result
}

export default fs
