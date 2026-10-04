import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync,readdirSync,lstatSync,realpathSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve,basename,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {assertNativeSDKRuntimePaths} from './native-runtime-paths.mjs'

const root=dirname(fileURLToPath(import.meta.url))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const safe=path=>typeof path==='string'&&!path.includes('\\')&&!path.startsWith('/')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..')
function verifyPackage(){
  const bytes=readFileSync(join(root,'package-assets.json')),manifest=JSON.parse(bytes)
  if(manifest.format!==1||!Array.isArray(manifest.files))throw Error('Invalid runtime package manifest')
  const seen=new Set()
  for(const file of manifest.files){
    if(!safe(file.path)||seen.has(file.path))throw Error('Invalid runtime package path')
    seen.add(file.path)
    let current=root
    for(const part of file.path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Runtime package symlink: '+file.path)}
    if(!lstatSync(current).isFile())throw Error('Expected runtime package file: '+file.path)
    const value=readFileSync(current)
    if(value.length!==file.bytes||hash(value)!==file.sha256)throw Error('Runtime package hash mismatch: '+file.path)
  }
  function inventory(directory,prefix=''){
    for(const name of readdirSync(directory)){
      const path=prefix?prefix+'/'+name:name
      // npm can install nested dependencies here. They have their own package
      // boundary and are validated by compiler-assets, not trusted as our files.
      if(!prefix&&name==='node_modules')continue
      const stat=lstatSync(join(directory,name))
      if(stat.isSymbolicLink())throw Error('Runtime package symlink: '+path)
      if(stat.isDirectory())inventory(join(directory,name),path)
      else if(!stat.isFile()||(path!=='package-assets.json'&&!seen.has(path)))throw Error('Unlisted runtime package file: '+path)
    }
  }
  inventory(root)
  if(json(join(root,'runtime-profile.json')).buildProfile==='native')assertNativeSDKRuntimePaths(manifest.files.map(file=>file.path))
  return {manifest,sha256:hash(bytes)}
}
export function readPreviewHostHostingContract(){verifyPackage();return json(join(root,'preview-host/hosting.json'))}
export function readRuntimeProfileManifest(){verifyPackage();return json(join(root,'runtime-profile.json'))}

/** Compiler candidates for owner files, using this package's verified inventory. */
export function readNativeRuntimeCandidates(runtimePath='/runtime/'){
  if(typeof runtimePath!=='string'||!runtimePath.startsWith('/')||runtimePath.startsWith('//')||
    !runtimePath.endsWith('/')||runtimePath.includes('\\')||
    new URL(runtimePath,'https://owner.invalid').pathname!==runtimePath||runtimePath.includes('?')||runtimePath.includes('#'))
    throw TypeError('runtimePath must be an absolute same-origin directory path')
  const profile=readRuntimeProfileManifest()
  const runtimes=profile.nativeRuntime?.runtimes??(profile.nativeRuntime?[profile.nativeRuntime]:[])
  return runtimes.map(runtime=>{
    if(typeof runtime.entry!=='string'||!safe(runtime.entry)||!runtime.entry.startsWith('runtime/'))throw Error('Invalid native runtime entry')
    const toolchain={vite:runtime.toolchain?.vite,rolldown:runtime.toolchain?.rolldown}
    if(Object.values(toolchain).some(version=>typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)))
      throw Error('Native runtime catalog requires exact compiler versions')
    return {workerURL:runtimePath+runtime.entry.slice('runtime/'.length),toolchain}
  })
}

/** Generate a browser deployment, not an npm package. No downloads or lifecycle scripts. */
export async function prepareRuntimeAssets(destination){
  if(typeof destination!=='string'||!destination||destination.includes('\0'))throw TypeError('Expected a new destination directory')
  const verified=verifyPackage(),requested=resolve(destination),parent=realpathSync(dirname(requested)),target=join(parent,basename(requested))
  const inside=relative(realpathSync(root),target)
  if(!inside||(!inside.startsWith('..'+sep)&&inside!=='..'))throw Error('Destination must be outside the runtime package')
  const config=json(join(root,'compiler-config.json'))
  const profile=json(join(root,'runtime-profile.json')),nativeOnly=profile.buildProfile==='native'
  if(nativeOnly&&(config.format!==1||config.mode!=='native'||Object.keys(config).sort().join(',')!=='format,mode'||!profile.nativeRuntime))
    throw Error('Invalid native runtime setup configuration')
  // mkdir refuses existing directories and symlinks. Failed assembly is left for inspection.
  mkdirSync(target)
  let assembled={}
  if(nativeOnly){
    mkdirSync(join(target,'runtime'))
  }else{
  const {assembleCompilerAssets}=await import('./compiler-assets.mjs')
  assembled=await assembleCompilerAssets(join(target,'runtime'),{
    resolveFrom:import.meta.url,compilerArtifact:config.compilerArtifact,
    ...(config.parserInputs?{parserInputs:config.parserInputs,parserEntry:join(root,'adapter/worker.mjs')}:{})})
  }
  for(const file of verified.manifest.files){
    if(!file.path.startsWith('runtime/')&&!file.path.startsWith('preview-host/')&&!file.path.startsWith('licenses/')&&!['kernel-host.js','kernel-host.html'].includes(file.path))continue
    const output=join(target,file.path)
    mkdirSync(dirname(output),{recursive:true})
    try{copyFileSync(join(root,file.path),output,1)}catch(error){
      if(error.code!=='EEXIST'||hash(readFileSync(output))!==file.sha256)throw error
    }
  }
  if(profile.nativeRuntime){
    const runtimes=profile.nativeRuntime.runtimes
    const prefixes=runtimes===undefined?['runtime/native/']:runtimes.map(runtime=>{
      const {vite,rolldown}=runtime.toolchain??{}
      if([vite,rolldown].some(version=>typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)))
        throw Error('Invalid native runtime toolchain')
      const prefix=`runtime/native/vite-${vite}-rolldown-${rolldown}/`
      if(runtime.entry!==prefix+'engine.js')throw Error('Invalid native runtime entry')
      return prefix
    })
    if(!prefixes.length||new Set(prefixes).size!==prefixes.length||profile.nativeRuntime.externalAssets?.length!==prefixes.length*2)
      throw Error('Native runtime compiler dependency list is incomplete')
    const require=createRequire(import.meta.url)
    const external=Object.fromEntries(prefixes.flatMap(prefix=>[
      [prefix+'esbuild.wasm',{package:'esbuild-wasm',version:'0.28.2',packagePath:'esbuild.wasm',...(!nativeOnly?{source:join(target,'runtime/compiler/esbuild.wasm')}:{})}],
      [prefix+'rolldown-binding.wasm32-wasi.wasm',{package:'@rolldown/browser',packagePath:'dist/rolldown-binding.wasm32-wasi.wasm'}],
    ]))
    const seen=new Set()
    for(const asset of profile.nativeRuntime.externalAssets??[]){
      const expected=external[asset.path]
      if(!expected||seen.has(asset.path)||asset.package!==expected.package||
        !(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).test(asset.version)||
        (expected.version!==undefined&&asset.version!==expected.version)||
        asset.packagePath!==expected.packagePath||!(/^[a-f0-9]{64}$/).test(asset.sha256))
        throw Error('Unsupported native runtime dependency asset: '+asset.path)
      seen.add(asset.path)
      const dependency=asset.dependency??asset.package
      if(dependency!==asset.package&&!/^native-compiler-[a-z0-9-]+$/.test(dependency))throw Error('Unsupported native compiler dependency alias')
      const manifestPath=require.resolve(`${dependency}/package.json`)
      const manifest=json(manifestPath)
      if(manifest.name!==asset.package||manifest.version!==asset.version)throw Error('Native runtime dependency version mismatch: '+asset.package)
      const source=expected.source??join(dirname(manifestPath),asset.packagePath)
      const bytes=readFileSync(source)
      if(hash(bytes)!==asset.sha256)throw Error('Native runtime dependency hash mismatch: '+asset.path)
      const output=join(target,asset.path)
      mkdirSync(dirname(output),{recursive:true})
      copyFileSync(source,output,1)
    }
  }
  if(assembled.parser&&config.parserPolicy){
    const artifact={...config.parserPolicy,assets:assembled.parser.assets,sources:assembled.parser.sources??{}}
    writeFileSync(join(target,'runtime/rolldown-parser/artifact.json'),JSON.stringify(artifact,null,2)+'\n')
  }
  const files=[]
  function visit(directory,prefix=''){
    for(const name of readdirSync(directory).sort()){
      const path=prefix?prefix+'/'+name:name,absolute=join(directory,name),stat=lstatSync(absolute)
      if(stat.isSymbolicLink())throw Error('Deployment symlink: '+path)
      if(stat.isDirectory())visit(absolute,path)
      else if(stat.isFile()){const bytes=readFileSync(absolute);files.push({path,bytes:bytes.length,sha256:hash(bytes)})}
      else throw Error('Unsupported deployment file: '+path)
    }
  }
  visit(target)
  const manifestPath=join(target,'deployment-manifest.json')
  writeFileSync(manifestPath,JSON.stringify({format:1,packageManifestSHA256:verified.sha256,files},null,2)+'\n',{flag:'wx'})
  return {directory:target,runtimeDirectory:join(target,'runtime'),previewHostDirectory:join(target,'preview-host'),
    ...(nativeOnly?{}:{kernelHostPath:join(target,'kernel-host.html')}),
    ...(files.some(file=>file.path==='runtime/native/engine.js')?{nativeWorkerPath:join(target,'runtime/native/engine.js')}:{}),manifestPath}
}
