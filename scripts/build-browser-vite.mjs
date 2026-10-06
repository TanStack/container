import { build,transform } from 'esbuild'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import {existsSync} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {addPackageNotices} from './package-notices.mjs'
import {transformToolchainDynamicImports} from './toolchain-dynamic-imports.mjs'
import {traceVitePrivateCallback} from './vite-private-callback-trace.mjs'
import {retryInvalidatedViteClientTransform} from './vite-client-transform-invalidation.mjs'
import {coordinateViteModuleEvaluationClient,coordinateViteModuleEvaluationCompiler} from './vite-module-evaluation.mjs'
import {canonicalCompilerPackageRoot,isCompilerPackageImporter} from './compiler-package-paths.mjs'
import {compilerInputPaths} from './compiler-input-paths.mjs'
import {browserCompilerWorkerPool} from './compiler-worker-pool.mjs'
import {replaceWasiFsProxy} from './wasi-fs-proxy-transport.mjs'
import {sizeCompilerMemoryBinding} from './compiler-wasm-memory.mjs'
import {addCompilerBootstrapProgress} from './compiler-bootstrap-progress.mjs'
import {compilerBrowserHostPlugin} from './compiler-host-target.mjs'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = path.join(projectRoot, 'src/vite-browser')
const compilerWorkerPool=browserCompilerWorkerPool()
const vitePackageRoot = await canonicalCompilerPackageRoot(
  process.env.BROWSER_VITE_PACKAGE_ROOT ?? path.join(projectRoot, 'node_modules/vite'),
)
const rolldownPackageRoot = process.env.BROWSER_ROLLDOWN_PACKAGE_ROOT
  ? await canonicalCompilerPackageRoot(process.env.BROWSER_ROLLDOWN_PACKAGE_ROOT)
  : undefined
const oxidePackageRoot = process.env.BROWSER_OXIDE_PACKAGE_ROOT
  ? path.resolve(process.env.BROWSER_OXIDE_PACKAGE_ROOT)
  : undefined
const resolvePackageExport = (packageRoot, exports, subpath) => {
  const value = exports[subpath]
  const target = typeof value === 'string' ? value : value?.browser ?? value?.default
  if (typeof target !== 'string') throw Error(`Missing browser package export ${subpath} in ${packageRoot}`)
  return path.join(packageRoot, target)
}
const [viteExports,rolldownExports] = await Promise.all([
  readFile(path.join(vitePackageRoot,'package.json'),'utf8').then(source=>JSON.parse(source).exports),
  rolldownPackageRoot
    ? readFile(path.join(rolldownPackageRoot,'package.json'),'utf8').then(source=>JSON.parse(source).exports)
    : undefined,
])
const browserViteVersion = JSON.parse(await readFile(path.join(vitePackageRoot,'package.json'),'utf8')).version
const browserRolldownVersion = rolldownPackageRoot
  ? JSON.parse(await readFile(path.join(rolldownPackageRoot, 'package.json'), 'utf8')).version
  : ''
const lightningcssWasmRoot = path.dirname(require.resolve('lightningcss-wasm/lightningcss_node.wasm'))
const lightningcss132WasmRoot = path.dirname(require.resolve('lightningcss-wasm-132/lightningcss_node.wasm'))
const browserLightningcssVersion = JSON.parse(await readFile(path.join(lightningcssWasmRoot, 'package.json'), 'utf8')).version
const browserPrettierVersion = JSON.parse(await readFile(require.resolve('prettier/package.json'), 'utf8')).version
const outputRoot = process.env.BROWSER_VITE_OUTPUT_DIRECTORY
  ? path.resolve(process.env.BROWSER_VITE_OUTPUT_DIRECTORY)
  : path.join(projectRoot, 'public/vite-runtime')
const startDefaultEntryRoot = path.join(
  projectRoot,
  'node_modules/@tanstack/react-start/dist/plugin/default-entry',
)
const [startClientEntry, startServerEntry, startInstanceEntry] = await Promise.all([
  readFile(path.join(startDefaultEntryRoot, 'client.tsx'), 'utf8'),
  readFile(path.join(startDefaultEntryRoot, 'server.ts'), 'utf8'),
  readFile(path.join(startDefaultEntryRoot, 'start.ts'), 'utf8'),
])
const [viteClientEntry,viteEnvEntry]=await Promise.all([
  readFile(path.join(vitePackageRoot,'dist/client/client.mjs'),'utf8'),
  readFile(path.join(vitePackageRoot,'dist/client/env.mjs'),'utf8'),
])
const moduleEvaluationEnabled=browserViteVersion.startsWith('8.')&&
  process.env.BROWSER_VITE_ENTRY_POINT?.endsWith('/src/native/dev-server-vite8-bootstrap.worker.ts')
const browserViteClientEntry=moduleEvaluationEnabled
  ? coordinateViteModuleEvaluationClient(viteClientEntry)
  : viteClientEntry

const aliases = new Map([
  ['assert', 'assert'], ['node:assert', 'assert'],
  ['buffer', 'buffer'], ['node:buffer', 'buffer'],
  ['node:constants', 'constants-browserify'],
  ['crypto', path.join(sourceRoot, 'node-crypto.ts')], ['node:crypto', path.join(sourceRoot, 'node-crypto.ts')],
  ['node:domain', 'domain-browser'],
  ['events', path.join(sourceRoot, 'node-events.ts')], ['node:events', path.join(sourceRoot, 'node-events.ts')],
  ['http', path.join(projectRoot, 'src/sandbox/guest-http.js')], ['node:http', path.join(projectRoot, 'src/sandbox/guest-http.js')],
  ['https', 'https-browserify'], ['node:https', 'https-browserify'],
  ['os', 'os-browserify/browser'], ['node:os', 'os-browserify/browser'],
  ['path', path.join(sourceRoot, 'node-path.ts')], ['node:path', path.join(sourceRoot, 'node-path.ts')],
  ['node:path/posix', path.join(sourceRoot, 'node-path-posix.ts')],
  ['process', 'process/browser'], ['node:process', 'process/browser'],
  ['querystring', 'querystring-es3'], ['node:querystring', 'querystring-es3'],
  ['stream', 'stream-browserify'], ['node:stream', 'stream-browserify'],
  ['node:string_decoder', 'string_decoder'],
  ['node:tty', 'tty-browserify'],
  ['url', require.resolve('url/')], ['node:url', path.join(sourceRoot, 'node-url.ts')],
  ['node:util', process.env.BROWSER_VITE_PACKAGE_ROOT
    ? path.join(sourceRoot, 'node-util.ts')
    : require.resolve('util/')],
  ['vm', path.join(projectRoot,'src/vite-browser/node-vm.ts')], ['node:vm', path.join(projectRoot,'src/vite-browser/node-vm.ts')],
  ['zlib', path.join(sourceRoot, 'node-zlib.ts')], ['node:zlib', path.join(sourceRoot, 'node-zlib.ts')],
  ['fs', path.join(sourceRoot, 'node-fs.ts')], ['node:fs', path.join(sourceRoot, 'node-fs.ts')],
  ['fs/promises', path.join(sourceRoot, 'node-fs-promises.ts')], ['node:fs/promises', path.join(sourceRoot, 'node-fs-promises.ts')],
  ['module', path.join(sourceRoot, 'node-module.ts')], ['node:module', path.join(sourceRoot, 'node-module.ts')],
  ['prettier', path.join(sourceRoot, 'prettier.ts')],
  ['esbuild', path.join(sourceRoot, 'esbuild-shim.ts')],
  ['node:perf_hooks', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:async_hooks', path.join(sourceRoot, 'node-async-hooks.ts')],
  ['node:stream/promises', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:stream/web', path.join(sourceRoot, 'node-stream-web.ts')],
  ['node:timers/promises', path.join(sourceRoot, 'node-timers-promises.ts')],
  ['node:worker_threads', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:child_process', path.join(sourceRoot, '../native/child-process.ts')],
  ['child_process', path.join(sourceRoot, '../native/child-process.ts')],
  ['node:dns', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:http2', path.join(sourceRoot, 'node-stubs.ts')],
  ['net', path.join(projectRoot, 'src/sandbox/guest-net.js')], ['node:net', path.join(projectRoot, 'src/sandbox/guest-net.js')],
  ['node:tls', path.join(sourceRoot, 'node-stubs.ts')],
  ['node:v8', path.join(sourceRoot, 'node-v8.ts')],
  ['v8', path.join(sourceRoot, 'node-v8.ts')],
  ['node:wasi', path.join(sourceRoot, 'node-wasi.ts')],
  ['node:readline', path.join(sourceRoot, 'node-stubs.ts')],
  ['fsevents', path.join(sourceRoot, 'node-stubs.ts')],
  ['lightningcss', path.join(lightningcssWasmRoot, 'index.mjs')],
])
const explicitPackageEntries = new Map([
  ['assert', require.resolve('assert/')],
  ['buffer', require.resolve('buffer/')],
  ['events', require.resolve('events/')],
  ['util', require.resolve('util/')],
])
aliases.set('console',path.join(sourceRoot,'node-console.ts'))
aliases.set('node:console',path.join(sourceRoot,'node-console.ts'))
aliases.set('tls',path.join(sourceRoot,'node-tls.ts'))
aliases.set('node:tls',path.join(sourceRoot,'node-tls.ts'))
const bundledInputs=new Set()
if(moduleEvaluationEnabled)bundledInputs.add(path.join(projectRoot,'scripts/vite-module-evaluation.mjs'))
const compilerHostTargets=new Map()
const compilerHostPlugin=compilerBrowserHostPlugin(target=>{
  compilerHostTargets.set(target.name+'@'+target.version,target)
  bundledInputs.add(path.join(projectRoot,'scripts/compiler-host-target.mjs'))
})
const compilerMemories={}
const sizeCompilerBinding=async(name,source,wasmPath)=>{
  if(compilerMemories[name])throw Error('Compiler memory binding applied more than once: '+name)
  const result=sizeCompilerMemoryBinding(source,await readFile(wasmPath))
  compilerMemories[name]=result.memory
  bundledInputs.add(path.join(projectRoot,'scripts/compiler-wasm-memory.mjs'))
  return result.contents
}
const recordInputs=(result,inputRoot=projectRoot)=>{for(const name of compilerInputPaths(inputRoot,result.metafile))bundledInputs.add(name)}
const wasiTransportApplied={worker:0,main:0,oxide:0}
const wasiTransportModule=path.join(projectRoot,'src/native/wasi-fs-transport.mjs')
const wasiBootstrapModule=path.join(projectRoot,'src/native/wasi-filesystem-bootstrap.mjs')
const wasiThreadCompletionModule=path.join(projectRoot,'src/native/wasi-thread-completion.mjs')
const filesystemCodecPlugin={name:'filesystem-owner-codecs',setup(bundler){
  bundler.onResolve({filter:/^tanstack:filesystem-codec-(124|114)$/},args=>{
    const old=args.path.endsWith('114')
    if(old&&!oxidePackageRoot)throw Error('Filesystem codec 1.1.4 requires the locked Oxide package')
    const resolver=old?createRequire(path.join(oxidePackageRoot,'package.json')):require
    return {path:path.join(path.dirname(resolver.resolve('@napi-rs/wasm-runtime')),'fs-proxy.js')}
  })
}}
const wasiTransportPlugin=scope=>({name:'owned-wasi-filesystem-transport',setup(bundler){
  bundler.onLoad({filter:/fs-proxy\.js$/},async args=>{
    const root=path.dirname(args.path),manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'))
    if(manifest.name!=='@napi-rs/wasm-runtime')return
    if(!['1.1.4','1.2.4'].includes(manifest.version))throw Error('Unverified WASI filesystem codec version: '+manifest.version)
    const source=replaceWasiFsProxy(await readFile(args.path,'utf8'),wasiTransportModule,
      {trace:scope!=='worker'&&process.env.BROWSER_WASI_FS_PROXY_TRACE==='1'})
    wasiTransportApplied[scope]++
    return {contents:source,loader:'js',resolveDir:root}
  })
}})

await mkdir(outputRoot, { recursive: true })
await copyFile(
  require.resolve('esbuild-wasm/esbuild.wasm'),
  path.join(outputRoot, 'esbuild.wasm'),
)
await copyFile(path.join(lightningcssWasmRoot,'lightningcss_node.wasm'),path.join(outputRoot,'lightningcss_node.wasm'))
await copyFile(path.join(lightningcss132WasmRoot,'lightningcss_node.wasm'),path.join(outputRoot,'lightningcss-1.32.0.wasm'))
if(rolldownPackageRoot){
  await copyFile(path.join(rolldownPackageRoot,'dist/rolldown-binding.wasm32-wasi.wasm'),path.join(outputRoot,'rolldown-binding.wasm32-wasi.wasm'))
  recordInputs(await build({
    entryPoints:[path.join(rolldownPackageRoot,'dist/wasi-worker-browser.mjs')],
    outfile:path.join(outputRoot,'wasi-worker-browser.mjs'),
    bundle:true,platform:'browser',format:'esm',target:'es2022',
    nodePaths:[path.join(projectRoot,'node_modules'),...(process.env.BROWSER_VITE_NODE_PATH?[path.resolve(process.env.BROWSER_VITE_NODE_PATH)]:[])],
    metafile:true,
    plugins:[compilerHostPlugin,wasiTransportPlugin('worker'),{name:'direct-compiler-filesystem-bootstrap',setup(bundler){
      bundler.onLoad({filter:/wasi-worker-browser\.mjs$/},async args=>({
        contents:`import {installWasiFilesystemBootstrap} from ${JSON.stringify(wasiBootstrapModule)}\ninstallWasiFilesystemBootstrap('1.2.4')\n`+await readFile(args.path,'utf8'),
        loader:'js',resolveDir:path.dirname(args.path),
      }))
    }}],
  }))
}
if(oxidePackageRoot){
  const oxideManifest=JSON.parse(await readFile(path.join(oxidePackageRoot,'package.json'),'utf8'))
  if(oxideManifest.name!=='@tailwindcss/oxide-wasm32-wasi'||oxideManifest.version!=='4.3.3')
    throw Error('Browser Oxide toolchain must be @tailwindcss/oxide-wasm32-wasi@4.3.3')
  recordInputs(await build({
    // The verified Oxide package is staged at a content-addressed path inside
    // the workspace. Both it and workspace imports have stable source labels.
    absWorkingDir:projectRoot,
    entryPoints:{oxide:path.join(oxidePackageRoot,'tailwindcss-oxide.wasi-browser.js'),
      'wasi-worker-browser':path.join(oxidePackageRoot,'wasi-worker-browser.mjs')},
    outdir:path.join(outputRoot,'oxide'),
    outExtension:{'.js':'.mjs'},
    bundle:true,
    splitting:true,
    platform:'browser',
    format:'esm',
    target:'es2022',
    logLevel:'warning',
    plugins:[compilerHostPlugin,wasiTransportPlugin('oxide'),{name:'oxide-preloaded-browser-workers',setup(bundler){
      bundler.onLoad({filter:/wasi-worker-browser\.mjs$/},async args=>{
        const source=await readFile(args.path,'utf8'),handler='new MessageHandler({'
        if(source.split(handler).length!==2)throw Error('Pinned Oxide worker message handler changed')
        return {contents:`import {installWasiFilesystemBootstrap} from ${JSON.stringify(wasiBootstrapModule)}\nimport {createNativeWasiMessageHandler} from ${JSON.stringify(wasiThreadCompletionModule)}\ninstallWasiFilesystemBootstrap('1.1.4')\n`+
          source.replace(handler,'createNativeWasiMessageHandler(MessageHandler,{'),
          loader:'js',resolveDir:path.dirname(args.path)}
      })
      bundler.onLoad({filter:/tailwindcss-oxide\.wasi-browser\.js$/},async args=>{
        let contents=await sizeCompilerBinding('oxide',await readFile(args.path,'utf8'),
          path.join(oxidePackageRoot,'tailwindcss-oxide.wasm32-wasi.wasm'))
        const filesystem='export const { fs: __fs, vol: __volume } = memfs()'
        if(contents.split(filesystem).length!==2)throw Error('Pinned Oxide filesystem initialization changed')
        contents=`import {getCompilerFilesystem as __getCompilerFilesystem} from ${JSON.stringify(path.join(projectRoot,'src/native/compiler-filesystem-registry.ts'))}\n`+
          contents.replace(filesystem,'export const { fs: __fs, vol: __volume } = __getCompilerFilesystem()')
        const instantiateImport='instantiateNapiModuleSync as __emnapiInstantiateNapiModuleSync,'
        if(contents.split(instantiateImport).length!==2)throw Error('Pinned Oxide NAPI loader import changed')
        contents=contents.replace(instantiateImport,'')
        contents=`import {createNapiModule as __createNapiModule,loadNapiModule as __loadNapiModule} from '@emnapi/core'\nimport {instantiateNativeWasiModule as __instantiateNativeWasiModule} from ${JSON.stringify(wasiThreadCompletionModule)}\n`+contents
        contents=contents.replace('__emnapiInstantiateNapiModuleSync(__wasmFile, {',
          'await __instantiateNativeWasiModule(__createNapiModule,__loadNapiModule,__wasmFile, {')
        const moduleResult='napiModule: __napiModule,'
        if(contents.split(moduleResult).length!==2)throw Error('Pinned Oxide NAPI module result changed')
        contents=contents.replace(moduleResult,moduleResult+'\n  nativeThreadPool: __nativeThreadPool,')
        // Oxide keeps one parsing thread alive while a directory-walk thread
        // runs. Keep that actual concurrent capacity bounded and reusable.
        contents=contents.replace('asyncWorkPoolSize: 4,',
          'asyncWorkPoolSize: 2,\n  reuseWorker: { size: 2, strict: true },')
        contents='const __browserOxideWorkers = new Set()\n'+contents
        const listener="worker.addEventListener('message', __wasmCreateOnMessageForFsProxy(__fs))"
        if(contents.split(listener).length!==2)throw Error('Pinned Oxide filesystem worker lifecycle changed')
        contents=`import {manageWasiFilesystemWorker as __manageWasiFilesystemWorker} from ${JSON.stringify(wasiTransportModule)}\n`+
          contents.replace(listener,"__manageWasiFilesystemWorker(worker, __wasmCreateOnMessageForFsProxy(__fs))\n    __browserOxideWorkers.add(worker)")
        contents+='\nexport function disposeBrowserOxideWorkers(){\n  __nativeThreadPool.dispose()\n  __browserOxideWorkers.clear()\n}\nexport function inspectBrowserOxideWorkers(){return __nativeThreadPool.inspect()}\n'
        if(contents.includes('__emnapiInstantiateNapiModuleSync')||
          !contents.includes('reuseWorker: { size: 2, strict: true }')||
          !contents.includes('__browserOxideWorkers.add(worker)'))
          throw Error('Pinned Oxide browser binding does not match the preloaded-worker integration')
        return {contents,loader:'js',resolveDir:oxidePackageRoot}
      })
    }}],
    metafile:true,
  }))
  await copyFile(path.join(oxidePackageRoot,'tailwindcss-oxide.wasm32-wasi.wasm'),path.join(outputRoot,'oxide','tailwindcss-oxide.wasm32-wasi.wasm'))
}

let privateCallbackTraceApplied = 0
let invalidatedClientTransformRetryApplied = 0
let moduleEvaluationCompilerApplied = 0
if(rolldownPackageRoot&&oxidePackageRoot)recordInputs(await build({
  absWorkingDir:projectRoot,entryPoints:[path.join(projectRoot,'src/native/filesystem-owner.worker.mjs')],
  outfile:path.join(outputRoot,'filesystem-owner.mjs'),bundle:true,platform:'browser',format:'esm',target:'es2022',
  alias:{'node:path':'path-browserify','node:events':'events','node:buffer':'buffer','node:stream':'stream-browserify'},
  metafile:true,inject:[path.join(sourceRoot,'globals.ts')],
  plugins:[compilerHostPlugin,filesystemCodecPlugin,wasiTransportPlugin('main')],
}))
recordInputs(await build({
  absWorkingDir: projectRoot,
  bundle: true,
  define: {
    'process.env.NODE_ENV': 'process.env.NODE_ENV',
    __START_CLIENT_ENTRY__: JSON.stringify(startClientEntry),
    __START_SERVER_ENTRY__: JSON.stringify(startServerEntry),
    __START_INSTANCE_ENTRY__: JSON.stringify(startInstanceEntry),
    __VITE_CLIENT_ENTRY__: JSON.stringify(browserViteClientEntry),
    __VITE_ENV_ENTRY__: JSON.stringify(viteEnvEntry),
    __BROWSER_ROLLDOWN_VERSION__: JSON.stringify(browserRolldownVersion),
    __BROWSER_VITE_VERSION__: JSON.stringify(browserViteVersion),
    __BROWSER_VITE_PACKAGE_JSON__: JSON.stringify(await readFile(path.join(vitePackageRoot,'package.json'),'utf8')),
    __BROWSER_LIGHTNINGCSS_VERSION__: JSON.stringify(browserLightningcssVersion),
    __BROWSER_PRETTIER_VERSION__: JSON.stringify(browserPrettierVersion),
    __dirname: '"/vite-runtime"',
    'import.meta.dirname': '"/vite-runtime"',
    'import.meta.filename': '"/vite-runtime/engine.js"',
  },
  entryPoints: [process.env.BROWSER_VITE_ENTRY_POINT
    ? path.resolve(process.env.BROWSER_VITE_ENTRY_POINT)
    : path.join(sourceRoot, 'engine.ts')],
  format: 'esm',
  inject: [path.join(sourceRoot, 'globals.ts')],
  nodePaths: [path.join(projectRoot,'node_modules'),...(process.env.BROWSER_VITE_NODE_PATH ? [path.resolve(process.env.BROWSER_VITE_NODE_PATH)] : [])],
  loader: { '.wasm': 'binary' },
  logLevel: 'info',
  outfile: path.join(outputRoot, 'engine.js'),
  platform: 'browser',
  sourcemap: false,
  target: ['es2022'],
  metafile:true,
  plugins: [compilerHostPlugin,filesystemCodecPlugin,wasiTransportPlugin('main'),{
    name: 'vite-browser-aliases',
    setup(build) {
      if(browserViteVersion.startsWith('8.')&&process.env.BROWSER_VITE_ENTRY_POINT?.endsWith('/src/native/dev-server-vite8-bootstrap.worker.ts'))
        build.onLoad({filter:/\.js$/},async args=>{
          if(!isCompilerPackageImporter(vitePackageRoot,args.path))return
          const relative=path.relative(vitePackageRoot,args.path)
          let source=await readFile(args.path,'utf8')
          if(relative.split(path.sep).join('/')==='dist/node/chunks/node.js'){
            source=coordinateViteModuleEvaluationCompiler(source)
            moduleEvaluationCompilerApplied++
            source=retryInvalidatedViteClientTransform(source)
            invalidatedClientTransformRetryApplied++
            bundledInputs.add(path.join(projectRoot,'scripts/vite-client-transform-invalidation.mjs'))
          }
          if(process.env.BROWSER_VITE_RESOLVE_CALLBACK_TRACE==='1'&&relative.split(path.sep).join('/')==='dist/node/chunks/node.js'){
            source=traceVitePrivateCallback(source)
            privateCallbackTraceApplied++
          }
          return {contents:transformToolchainDynamicImports(source,path.join(projectRoot,'src/native/runtime-module-import.ts')),
            loader:'js',resolveDir:path.dirname(args.path)}
        })
      if(browserViteVersion.startsWith('7.'))build.onLoad({filter:/\.js$/},async args=>{
        if(!isCompilerPackageImporter(vitePackageRoot,args.path))return
        const relative=path.relative(vitePackageRoot,args.path)
        const contents=await readFile(args.path,'utf8')
        const identity='file:///__toolchain/vite/'+relative.split(path.sep).join('/')
        const result=await transform(contents,{loader:'js',target:'esnext',define:{'import.meta.url':JSON.stringify(identity)}})
        return {contents:result.code,loader:'js',resolveDir:path.dirname(args.path)}
      })
      if(rolldownPackageRoot)build.onLoad({filter:/rolldown-binding\.wasi-browser\.js$/},async args=>{
        if(args.path!==path.join(rolldownPackageRoot,'dist/rolldown-binding.wasi-browser.js'))return
        let contents=await sizeCompilerBinding('rolldown',await readFile(args.path,'utf8'),
          path.join(rolldownPackageRoot,'dist/rolldown-binding.wasm32-wasi.wasm'))
        if(process.env.BROWSER_VITE_ENTRY_POINT?.endsWith('/src/native/dev-server-vite8-bootstrap.worker.ts')){
          bundledInputs.add(path.join(projectRoot,'scripts/compiler-bootstrap-progress.mjs'))
          contents=addCompilerBootstrapProgress(contents,path.join(projectRoot,'src/native/compiler-bootstrap-progress.mjs'))
        }
        const filesystem='export const { fs: __fs, vol: __volume } = memfs()'
        if(contents.split(filesystem).length!==2)throw Error('Pinned Rolldown filesystem initialization changed')
        contents=`import {sharedCompilerFilesystem as __sharedCompilerFilesystem} from ${JSON.stringify(path.join(projectRoot,'src/native/compiler-filesystem.ts'))}\n`+
          contents.replace(filesystem,'export const { fs: __fs, vol: __volume } = __sharedCompilerFilesystem')
        const pool='const __asyncWorkPoolSize = 4\nconst __workerPoolSize = Math.max(\n  2,\n  globalThis.navigator?.hardwareConcurrency ?? 4,\n)'
        const publish='__publishWasiDispose(__napiModule.exports)'
        if(!contents.includes(pool)||!contents.includes(publish))
          throw Error('Pinned Rolldown browser binding does not match the worker lifecycle integration')
        contents=contents.replace(pool,`const __asyncWorkPoolSize = ${compilerWorkerPool.size}\nconst __workerPoolSize = ${compilerWorkerPool.size}`)
        const filesystemListener="worker.addEventListener('message', __wasmCreateOnMessageForFsProxy(__fs))"
        if(contents.split(filesystemListener).length!==2)throw Error('Pinned filesystem worker lifecycle changed')
        contents=`import {manageWasiFilesystemWorker as __manageWasiFilesystemWorker} from ${JSON.stringify(wasiTransportModule)}\n`+
          contents.replace(filesystemListener,'__manageWasiFilesystemWorker(worker, __wasmCreateOnMessageForFsProxy(__fs))')
        contents=contents.replace(publish,
          `${publish}\n  globalThis[Symbol.for('web-container:rolldown-binding')]=__napiModule.exports`)
        return {contents,loader:'js',resolveDir:path.dirname(args.path)}
      })
      build.onResolve({ filter: /.*/ }, (args) => {
        if(args.path==='@rolldown/browser'||args.path.startsWith('@rolldown/browser/')){
          if(!rolldownPackageRoot)return {path:path.join(projectRoot,'src/native/browser-rolldown-unavailable.ts')}
          const subpath=args.path==='@rolldown/browser'?'.':'.'+args.path.slice('@rolldown/browser'.length)
          return {path:resolvePackageExport(rolldownPackageRoot,rolldownExports,subpath)}
        }
        if (args.path === '@vitejs/devtools/config') return {path:args.path,external:true}
        // The package's ESM export compiles Wasm at init. Repeated large
        // workspace restores can stall that compile in WebKit workers, while
        // its maintained CommonJS export is the pure-JavaScript lexer.
        if (process.env.BROWSER_VITE_ENTRY_POINT?.endsWith('/src/native/dev-server-vite8-bootstrap.worker.ts') && args.path === 'cjs-module-lexer') {
          return {path:path.join(projectRoot,'node_modules/cjs-module-lexer/lexer.js')}
        }
        if (rolldownPackageRoot && args.path.endsWith('/rolldown-binding.wasi.cjs') && isCompilerPackageImporter(rolldownPackageRoot,args.importer)) {
          return {path:path.join(rolldownPackageRoot,'dist/rolldown-binding.wasi-browser.js')}
        }
        if (process.env.BROWSER_VITE_PACKAGE_ROOT && (args.path === 'vite' || args.path.startsWith('vite/'))) {
          const subpath=args.path==='vite'?'.':'.'+args.path.slice('vite'.length)
          return {path:resolvePackageExport(vitePackageRoot,viteExports,subpath)}
        }
        if (rolldownPackageRoot && (args.path === 'rolldown' || args.path.startsWith('rolldown/'))) {
          if(args.path==='rolldown'&&process.env.BROWSER_VITE_ENTRY_POINT?.endsWith('/src/native/dev-server-vite8-bootstrap.worker.ts'))
            return {path:path.join(projectRoot,'src/native/workspace-rolldown.ts')}
          const subpath=args.path==='rolldown'?'.':'.'+args.path.slice('rolldown'.length)
          return {path:resolvePackageExport(rolldownPackageRoot,rolldownExports,subpath)}
        }
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
}))

if(process.env.BROWSER_VITE_RESOLVE_CALLBACK_TRACE==='1'&&privateCallbackTraceApplied!==1)
  throw Error('Callback diagnostic build requires exactly one applied Vite callback transform')
if(browserViteVersion.startsWith('8.')&&process.env.BROWSER_VITE_ENTRY_POINT?.endsWith('/src/native/dev-server-vite8-bootstrap.worker.ts')&&invalidatedClientTransformRetryApplied!==1)
  throw Error('Native Vite build requires exactly one invalidated client transform correction')
if(moduleEvaluationEnabled&&moduleEvaluationCompilerApplied!==1)
  throw Error('Native Vite build requires matching client and compiler module lifetime corrections')
if(rolldownPackageRoot&&(!wasiTransportApplied.main||!wasiTransportApplied.worker))
  throw Error('WASI filesystem transport requires matching host and worker endpoints')
if(oxidePackageRoot&&!wasiTransportApplied.oxide)
  throw Error('Oxide filesystem transport requires matching host and worker endpoints')
if(rolldownPackageRoot&&!compilerMemories.rolldown||oxidePackageRoot&&!compilerMemories.oxide)
  throw Error('Compiler memory sizing requires every configured binding')
for(const identity of [...(rolldownPackageRoot?['@emnapi/core@2.0.0-alpha.5','@emnapi/wasi-threads@2.1.0']:[]),
  ...(oxidePackageRoot?['@emnapi/core@1.11.1','@emnapi/wasi-threads@1.2.2']:[])])
  if(!compilerHostTargets.has(identity))throw Error('Compiler browser host target was not applied: '+identity)

const packageRoots=new Set([vitePackageRoot,lightningcssWasmRoot,lightningcss132WasmRoot,
  path.join(projectRoot,'node_modules/esbuild-wasm'),
  ...(rolldownPackageRoot?[rolldownPackageRoot]:[]),
  ...(oxidePackageRoot?[oxidePackageRoot]:[])])
for(const input of bundledInputs){
  const marker=path.sep+'node_modules'+path.sep,index=input.lastIndexOf(marker)
  if(index<0)continue
  const rest=input.slice(index+marker.length).split(path.sep)
  packageRoots.add(input.slice(0,index+marker.length)+rest.slice(0,rest[0]?.startsWith('@')?2:1).join(path.sep))
}
const packages=new Map()
for(const root of [...packageRoots].sort()){
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'))
  addPackageNotices(packages,root,manifest)
}
const notices=[...packages.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version))
await writeFile(path.join(outputRoot,'THIRD-PARTY-NOTICES.txt'),notices.map(item=>
  `${item.name}@${item.version}\nDeclared license: ${item.license??'not declared'}\n${item.notices||'No license or notice text was present in this installed package. Distribution review remains open.'}`
).join('\n\n')+'\n')
const missingNoticeText=notices.filter(item=>!item.notices).map(item=>`${item.name}@${item.version}`)
await writeFile(path.join(outputRoot,'SHIPPED-INPUTS.json'),JSON.stringify({format:1,
  ...(process.env.BROWSER_VITE_RESOLVE_CALLBACK_TRACE==='1'||process.env.BROWSER_WASI_FS_PROXY_TRACE==='1'||compilerWorkerPool.diagnostic?{diagnostics:{
    ...(process.env.BROWSER_VITE_RESOLVE_CALLBACK_TRACE==='1'?{vitePrivateCallbackTrace:true}:{}),
    ...(process.env.BROWSER_WASI_FS_PROXY_TRACE==='1'?{wasiFilesystemReplyTrace:true}:{}),
    ...(compilerWorkerPool.diagnostic?{rolldownWorkerPoolControl:compilerWorkerPool.size}:{}),
  }}:{}),
  toolchain:{vite:browserViteVersion,rolldown:browserRolldownVersion||null,
    lightningcss:browserLightningcssVersion,prettier:browserPrettierVersion},
  ...(invalidatedClientTransformRetryApplied?{compatibilityCorrections:{retryInvalidatedClientTransform:true,
    ...(moduleEvaluationEnabled?{nativeModuleEvaluationOwnership:true,demandDrivenModuleObservation:true}:{})}}:{}),
  compilerMemories,
  compilerHostTargets:[...compilerHostTargets.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version)),
  noticeTextCoverageComplete:missingNoticeText.length===0,
  distributionReviewComplete:false,
  missingNoticeText,
  packages:notices.map(({name,version,license,notices})=>({name,version,license:license??null,noticeTextPresent:Boolean(notices)})),
  workspaceInputs:[...bundledInputs].filter(input=>existsSync(input)&&input.startsWith(projectRoot+path.sep)&&
    !input.includes(path.sep+'node_modules'+path.sep)&&!(oxidePackageRoot&&input.startsWith(oxidePackageRoot+path.sep)))
    .map(input=>path.relative(projectRoot,input).split(path.sep).join('/')).sort(),
},null,2)+'\n')
