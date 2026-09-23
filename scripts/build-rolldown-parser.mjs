import {build} from 'esbuild'
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises'
import {resolve,join,dirname,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')

/** Build only our adapter. Consumers resolve upstream code during asset setup. */
export async function buildRolldownAdapter(output){
  output=resolve(output)
  await mkdir(output)
  const result=await build({absWorkingDir:root,entryPoints:[join(root,'src/compiler/rolldown-parser.worker.mjs')],
    outfile:join(output,'worker.mjs'),bundle:true,platform:'browser',format:'esm',target:'es2022',metafile:true,
    external:['@napi-rs/wasm-runtime','@napi-rs/wasm-runtime/fs','@emnapi/runtime']})
  for(const name of Object.keys(result.metafile.inputs)){
    const local=relative(root,resolve(root,name))
    if(local.startsWith('..'+sep)||local==='..'||local.split(sep).includes('node_modules'))throw Error('Adapter contains an upstream or external build input: '+name)
  }
  return {entry:join(output,'worker.mjs'),sha256:digest(await readFile(join(output,'worker.mjs'))),inputs:Object.keys(result.metafile.inputs).sort()}
}

export async function buildRolldownParser(dependencyRoot,output){
  dependencyRoot=resolve(dependencyRoot);output=resolve(output)
  const pinned=JSON.parse(await readFile(join(root,'src/compiler/rolldown-parser-inputs.json'),'utf8'))
  const lock=await readFile(join(dependencyRoot,'package-lock.json'))
  if(digest(lock)!==pinned.lockSHA256)throw Error('Native parser lockfile does not match pinned inputs')
  const modules=join(dependencyRoot,'node_modules')
  for(const [name,hash]of Object.entries(pinned.inputs))if(digest(await readFile(join(modules,name)))!==hash)throw Error('Native parser input hash mismatch: '+name)
  const manifest=JSON.parse(await readFile(join(modules,'@rolldown/binding-wasm32-wasi/package.json'),'utf8'))
  if(manifest.version!==pinned.version)throw Error('Unsupported native parser version')
  // Require a fresh directory, never overwrite a previous artifact.
  await mkdir(output)
  const alias={
    '@napi-rs/wasm-runtime':join(modules,'@napi-rs/wasm-runtime/runtime.js'),
    '@napi-rs/wasm-runtime/runtime.js':join(modules,'@napi-rs/wasm-runtime/runtime.js'),
    '@napi-rs/wasm-runtime/fs':join(modules,'@napi-rs/wasm-runtime/dist/fs.js'),
    '@napi-rs/wasm-runtime/dist/fs.js':join(modules,'@napi-rs/wasm-runtime/dist/fs.js'),
    '@emnapi/runtime':join(modules,'@emnapi/runtime/dist/emnapi.js'),
  }
  const result=await build({absWorkingDir:root,entryPoints:{worker:join(root,'src/compiler/rolldown-parser.worker.mjs'),pthread:join(modules,'@rolldown/binding-wasm32-wasi/wasi-worker-browser.mjs')},outdir:output,bundle:true,platform:'browser',format:'esm',target:'es2022',metafile:true,alias})
  await copyFile(join(modules,'@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm'),join(output,'parser.wasm'))
  const sources={}
  for(const name of Object.keys(result.metafile.inputs)){
    const file=resolve(root,name),dependency=relative(modules,file),local=relative(root,file)
    const key=!dependency.startsWith('..'+sep)&&dependency!=='..'?'npm/'+dependency.split(sep).join('/'):'workspace/'+local.split(sep).join('/')
    if(key.includes('/../'))throw Error('Parser build input is outside declared roots')
    sources[key]=digest(await readFile(file))
  }
  const assets={}
  for(const name of ['worker.js','pthread.js','parser.wasm'])assets[name]=digest(await readFile(join(output,name)))
  // This describes implemented transport operations, not application acceptance.
  const callable={builtin:'builtin:vite-resolve',requiresOwnerWorkspace:true,resolveHook:'resolveId',invokeHooks:['load','transform'],update:{files:'existing',event:'update',hook:'watchChange'},callbacks:['resolveSubpathImports','onWarn','onDebug','finalizeBareSpecifier','finalizeOtherSpecifiers']}
  callable.builtins=['builtin:vite-resolve','builtin:oxc-runtime','builtin:vite-json']
  callable.update={files:'mirror',events:['create','update','delete'],hook:'watchChange'}
  const bundler={experimental:true,requiresOwnerWorkspace:true,methods:['generate','write','scan']}
  const metadata={version:pinned.version,enabledByDefault:false,operations:['parse','callable.create','callable.resolve','callable.invoke','callable.update','callable.dispose','bundler.create','bundler.run','bundler.context','bundler.close'],callable,bundler,requires:['crossOriginIsolated','SharedArrayBuffer'],resources:{full:{initialPages:4096,maximumPages:20480,maxWorkers:8,asyncWorkPoolSize:4},sync:{initialPages:1024,maximumPages:8192,maxWorkers:2,asyncWorkPoolSize:1},accounting:'Separate native compiler reservations, not included in the guest memory limit'},lockSHA256:pinned.lockSHA256,inputs:pinned.inputs,sources,assets}
  await writeFile(join(output,'artifact.json'),JSON.stringify(metadata,null,2)+'\n')
  return metadata
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4)throw Error('Usage: node scripts/build-rolldown-parser.mjs DEPENDENCY_ROOT NEW_OUTPUT_DIRECTORY')
  console.log(JSON.stringify(await buildRolldownParser(process.argv[2],process.argv[3]),null,2))
}
