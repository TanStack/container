import rollupWasmBytes from '@rollup/wasm-node/dist/wasm-node/bindings_wasm_bg.wasm'
import { Buffer } from 'buffer'
import * as esbuild from 'esbuild-wasm'
import process from 'process/browser'
import { readVolume, resetVolume } from './node-fs'

// This browser worker installs partial shims, not Node's complete global types.
const globals = globalThis as unknown as {
  Buffer: typeof Buffer
  process: typeof process
  global: typeof globalThis
  __rollupWasmBytes: Uint8Array
}
globals.Buffer = Buffer
globals.process = process
globals.global = globalThis
globals.__rollupWasmBytes = rollupWasmBytes
const bufferToString = Buffer.prototype.toString
Buffer.prototype.toString = function (encoding?: BufferEncoding, start?: number, end?: number) {
  if (encoding === 'base64url') {
    return bufferToString.call(this, 'base64', start, end)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
  }
  return bufferToString.call(this, encoding, start, end)
}
process.cwd = () => '/app'
process.chdir = () => {}
process.env.NODE_ENV = 'production'
process.versions.node = '22.0.0'
const outputStream = { isTTY: false, columns: 80, getColorDepth: () => 1 }
;(process as typeof process & { stdout: typeof outputStream; stderr: typeof outputStream }).stdout = outputStream
;(process as typeof process & { stdout: typeof outputStream; stderr: typeof outputStream }).stderr = outputStream

// The toolchain already has a dedicated worker. Keep its compiler service in
// the same lifetime so completion cannot leave a nested service running.
await esbuild.initialize({ wasmURL: '/vite-runtime/esbuild.wasm', worker: false })

function resetBrowserVolume(files: Record<string, string | Uint8Array>) {
  resetVolume({
    ...files,
    '/plugin/default-entry/client.tsx': __START_CLIENT_ENTRY__,
    '/plugin/default-entry/server.ts': __START_SERVER_ENTRY__,
    '/plugin/default-entry/start.ts': __START_INSTANCE_ENTRY__,
  })
}

export interface BrowserViteBuildResult {
  files: Record<string, Uint8Array>
  duration: number
}

export async function runBrowserViteSmokeBuild(
  files: Record<string, string | Uint8Array>,
): Promise<BrowserViteBuildResult> {
  resetBrowserVolume(files)
  const started = performance.now()
  const { build } = await import('vite')
  await build({
    root: '/app',
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      emptyOutDir: true,
      lib: { entry: '/app/src/main.ts', formats: ['es'] },
      outDir: '/app/dist',
      write: true,
    },
  })
  return { files: readVolume('/app/dist'), duration: performance.now() - started }
}

export async function runBrowserStartBuild(
  files: Record<string, string | Uint8Array>,
): Promise<BrowserViteBuildResult> {
  resetBrowserVolume(files)
  const started = performance.now()
  const [{ createBuilder }, { tanstackStart }, { default: react }] = await Promise.all([
    import('vite'),
    import('@tanstack/react-start/plugin/vite'),
    import('@vitejs/plugin-react'),
  ])
  const builder = await createBuilder({
    root: '/app',
    base: '/',
    configFile: false,
    logLevel: 'warn',
    plugins: [tanstackStart(), react()],
    build: {
      emptyOutDir: true,
      write: true,
    },
  })
  await builder.buildApp()
  return { files: readVolume('/app/dist'), duration: performance.now() - started }
}

;(globalThis as typeof globalThis & {
  __browserViteEngine?: {
    runBrowserStartBuild: typeof runBrowserStartBuild
    runBrowserViteSmokeBuild: typeof runBrowserViteSmokeBuild
  }
}).__browserViteEngine = { runBrowserStartBuild, runBrowserViteSmokeBuild }

if (typeof document === 'undefined') {
  self.onmessage = async event => {
    let reply
    try {
      const { method, files } = event.data
      const result = method === 'runBrowserStartBuild'
        ? await runBrowserStartBuild(files)
        : method === 'runBrowserViteSmokeBuild'
          ? await runBrowserViteSmokeBuild(files)
          : undefined
      if (!result) throw new Error('Unknown Vite build operation')
      reply={result}
    } catch (error) { reply={ error: String(error) + '\n' + (error instanceof Error ? error.stack : '') } }
    try { await esbuild.stop() }
    catch(error){ reply={error:'Vite compiler cleanup failed: '+String(error)} }
    self.postMessage(reply)
  }
  self.postMessage({ type: 'ready' })
}
