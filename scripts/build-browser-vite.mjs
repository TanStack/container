import { build } from 'esbuild'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = path.join(projectRoot, 'src/vite-browser')
const outputRoot = path.join(projectRoot, 'public/vite-runtime')
const startDefaultEntryRoot = path.join(
  projectRoot,
  'node_modules/@tanstack/react-start/dist/plugin/default-entry',
)
const [startClientEntry, startServerEntry, startInstanceEntry] = await Promise.all([
  readFile(path.join(startDefaultEntryRoot, 'client.tsx'), 'utf8'),
  readFile(path.join(startDefaultEntryRoot, 'server.ts'), 'utf8'),
  readFile(path.join(startDefaultEntryRoot, 'start.ts'), 'utf8'),
])

const aliases = new Map([
  ['assert', 'assert'], ['node:assert', 'assert'],
  ['buffer', 'buffer'], ['node:buffer', 'buffer'],
  ['node:constants', 'constants-browserify'],
  ['crypto', path.join(sourceRoot, 'node-crypto.ts')], ['node:crypto', path.join(sourceRoot, 'node-crypto.ts')],
  ['node:domain', 'domain-browser'],
  ['events', 'events'], ['node:events', 'events'],
  ['http', 'stream-http'], ['node:http', 'stream-http'],
  ['https', 'https-browserify'], ['node:https', 'https-browserify'],
  ['os', 'os-browserify/browser'], ['node:os', 'os-browserify/browser'],
  ['path', path.join(sourceRoot, 'node-path.ts')], ['node:path', path.join(sourceRoot, 'node-path.ts')],
  ['process', 'process/browser'], ['node:process', 'process/browser'],
  ['querystring', 'querystring-es3'], ['node:querystring', 'querystring-es3'],
  ['stream', 'stream-browserify'], ['node:stream', 'stream-browserify'],
  ['node:string_decoder', 'string_decoder'],
  ['node:tty', 'tty-browserify'],
  ['url', require.resolve('url/')], ['node:url', path.join(sourceRoot, 'node-url.ts')],
  ['util', 'util'], ['node:util', 'util'],
  ['vm', 'vm-browserify'], ['node:vm', 'vm-browserify'],
  ['zlib', 'browserify-zlib'], ['node:zlib', 'browserify-zlib'],
  ['fs', path.join(sourceRoot, 'node-fs.ts')], ['node:fs', path.join(sourceRoot, 'node-fs.ts')],
  ['fs/promises', path.join(sourceRoot, 'node-fs-promises.ts')], ['node:fs/promises', path.join(sourceRoot, 'node-fs-promises.ts')],
  ['module', path.join(sourceRoot, 'node-module.ts')], ['node:module', path.join(sourceRoot, 'node-module.ts')],
  ['prettier', path.join(sourceRoot, 'prettier.ts')],
  ['esbuild', path.join(sourceRoot, 'esbuild-shim.ts')],
  ['node:perf_hooks', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:async_hooks', path.join(sourceRoot, 'node-async-hooks.ts')],
  ['node:stream/promises', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:stream/web', path.join(sourceRoot, 'node-stream-web.ts')],
  ['node:worker_threads', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:child_process', path.join(sourceRoot, 'node-stubs.ts')],
  ['child_process', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:dns', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:http2', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:net', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:tls', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:v8', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:readline', path.join(sourceRoot, 'node-stubs.ts')],
  ['fsevents', path.join(sourceRoot, 'node-stubs.ts')],
  ['lightningcss', path.join(sourceRoot, 'node-stubs.ts')],
])

const explicitPackageEntries = new Map([
  ['assert', require.resolve('assert/')],
  ['buffer', require.resolve('buffer/')],
  ['events', require.resolve('events/')],
  ['util', require.resolve('util/')],
])

await mkdir(outputRoot, { recursive: true })
await copyFile(
  require.resolve('esbuild-wasm/esbuild.wasm'),
  path.join(outputRoot, 'esbuild.wasm'),
)

await build({
  absWorkingDir: projectRoot,
  bundle: true,
  define: {
    __START_CLIENT_ENTRY__: JSON.stringify(startClientEntry),
    __START_SERVER_ENTRY__: JSON.stringify(startServerEntry),
    __START_INSTANCE_ENTRY__: JSON.stringify(startInstanceEntry),
    __dirname: '"/vite-runtime"',
    'import.meta.dirname': '"/vite-runtime"',
    'import.meta.filename': '"/vite-runtime/engine.js"',
  },
  entryPoints: [path.join(sourceRoot, 'engine.ts')],
  format: 'esm',
  inject: [path.join(sourceRoot, 'globals.ts')],
  loader: { '.wasm': 'binary' },
  logLevel: 'info',
  outfile: path.join(outputRoot, 'engine.js'),
  platform: 'browser',
  sourcemap: false,
  target: ['es2022'],
  plugins: [{
    name: 'vite-browser-aliases',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (
          args.path.startsWith('#tanstack-') ||
          args.path === 'tanstack-start-manifest:v'
        ) return { path: args.path, external: true }
        let target = aliases.get(args.path)
        if (args.path === 'rollup' || args.path.startsWith('rollup/')) {
          const subpath = args.path.slice('rollup'.length)
          const file = subpath === '/parseAst'
            ? 'parseAst.js'
            : subpath === '/getLogFilter'
              ? 'getLogFilter.js'
              : 'rollup.js'
          return { path: path.join(projectRoot, 'node_modules/@rollup/wasm-node/dist/es', file) }
        }
        if (!target) return
        if (path.isAbsolute(target)) return { path: target }
        if (explicitPackageEntries.has(target)) return { path: explicitPackageEntries.get(target) }
        return { path: require.resolve(target) }
      })
    },
  }],
})
