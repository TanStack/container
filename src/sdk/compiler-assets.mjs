import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {readFileSync,existsSync,lstatSync,realpathSync,mkdirSync,writeFileSync,copyFileSync,readdirSync} from 'node:fs'
import {dirname,join,resolve,basename,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const readJSON=path=>JSON.parse(readFileSync(path,'utf8'))
export const requiredDependencies=Object.freeze({'esbuild-wasm':'0.28.2',esbuild:'0.28.2','@rolldown/binding-wasm32-wasi':'1.2.9','@napi-rs/wasm-runtime':'1.2.4','@emnapi/runtime':'2.0.0-alpha.5','@emnapi/core':'2.0.0-alpha.5','@emnapi/wasi-threads':'2.1.0','@tybys/wasm-util':'0.10.4',tslib:'2.8.1'})
function packageAt(require,name){
  let root=dirname(require.resolve(name))
  for(;;){
    const file=join(root,'package.json')
    if(existsSync(file)&&readJSON(file).name===name)return {root,manifest:readJSON(file)}
    const parent=dirname(root)
    if(parent===root)throw Error('Cannot locate installed package '+name)
    root=parent
  }
}
function verifyFiles(root,files){
  for(const [path,expected]of Object.entries(files)){
    if(isAbsolute(path)||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Invalid compiler input path: '+path)
    if(hash(readFileSync(join(root,path)))!==expected)throw Error('Compiler input hash mismatch: '+path)
  }
}
function notices(packages,destination){
  const records=[]
  for(const {root,manifest}of packages){
    const files=readdirSync(root,{withFileTypes:true}).filter(entry=>/^(license|licence|notice|copying|third-party-license)([._-]|$)/i.test(entry.name))
    const record={name:manifest.name,version:manifest.version,declaredLicense:manifest.license??null,files:[]}
    for(const entry of files){
      if(!entry.isFile())throw Error('Expected regular notice file: '+entry.name)
      const bytes=readFileSync(join(root,entry.name)),name=manifest.name.replaceAll('/','__')+'-'+entry.name
      writeFileSync(join(destination,name),bytes,{flag:'wx'})
      record.files.push({path:name,sha256:hash(bytes)})
    }
    records.push(record)
  }
  writeFileSync(join(destination,'inventory.json'),JSON.stringify({complete:false,scope:'Installed package notices, not complete embedded dependency attribution',packages:records},null,2)+'\n',{flag:'wx'})
}

/** Assemble installed compiler dependencies into a new directory. No network or lifecycle scripts. */
export async function assembleCompilerAssets(destination,{resolveFrom=import.meta.url,parserEntry,compilerArtifact,parserInputs}={}){
  if(typeof destination!=='string'||!destination||destination.includes('\0'))throw TypeError('Expected a new destination directory')
  const requested=resolve(destination),parent=realpathSync(dirname(requested)),target=join(parent,basename(requested))
  if(existsSync(target))throw Error('Compiler asset destination already exists')
  if(Boolean(parserEntry)!==Boolean(parserInputs))throw Error('Parser entry and pinned inputs must be supplied together')
  const require=createRequire(resolveFrom),compiler=packageAt(require,'esbuild-wasm')
  if(!compilerArtifact?.hashes||compiler.manifest.version!==requiredDependencies['esbuild-wasm']||compiler.manifest.version!==compilerArtifact.version)throw Error('Unsupported esbuild-wasm version')
  verifyFiles(compiler.root,compilerArtifact.hashes)
  let binding,packages,build,pinnedPackages,plugins
  if(parserInputs){
    binding=packageAt(require,'@rolldown/binding-wasm32-wasi')
    if(binding.manifest.version!==parserInputs.version)throw Error('Unsupported Rolldown binding version')
    const grouped=new Map()
    for(const [path,digest]of Object.entries(parserInputs.inputs)){
      const segments=path.split('/'),name=segments.slice(0,path.startsWith('@')?2:1).join('/')
      if(!grouped.has(name))grouped.set(name,{...packageAt(require,name),files:{}})
      grouped.get(name).files[path.slice(name.length+1)]=digest
    }
    packages=[...grouped.values()]
    for(const pkg of packages)verifyFiles(pkg.root,pkg.files)
    pinnedPackages=new Map()
    for(const [name,version]of Object.entries(requiredDependencies)){
      const pkg=packageAt(require,name)
      if(pkg.manifest.version!==version)throw Error('Unsupported compiler dependency version: '+name)
      pinnedPackages.set(name,{...pkg,root:realpathSync(pkg.root)})
    }
    // Resolve every compiler package edge from our pinned direct dependencies.
    // Let esbuild interpret each package's public exports and browser/import
    // conditions, rather than selecting a private file or an importer's nested
    // copy. This makes npm and pnpm use the same supported compiler graph.
    const resolveDirectory=dirname(resolveFrom instanceof URL?fileURLToPath(resolveFrom):String(resolveFrom).startsWith('file:')?fileURLToPath(resolveFrom):resolve(resolveFrom))
    const legacy={'@napi-rs/wasm-runtime/runtime.js':'@napi-rs/wasm-runtime','@napi-rs/wasm-runtime/dist/fs.js':'@napi-rs/wasm-runtime/fs'}
    plugins=[{name:'pinned-compiler-dependencies',setup(builder){
      builder.onResolve({filter:/^[^./]/},async args=>{
        if(args.pluginData?.pinnedCompilerResolution)return
        const specifier=legacy[args.path]??args.path
        const name=specifier.split('/').slice(0,specifier.startsWith('@')?2:1).join('/')
        const pinned=pinnedPackages.get(name)
        if(!pinned)return
        const result=await builder.resolve(specifier,{resolveDir:resolveDirectory,kind:args.kind,pluginData:{pinnedCompilerResolution:true}})
        if(result.errors.length)return result
        const inside=relative(pinned.root,realpathSync(result.path))
        if(!inside||inside==='..'||inside.startsWith('../')||isAbsolute(inside))throw Error('Compiler dependency resolved outside pinned package: '+name)
        // The recursion guard is only for this resolution, never descendants.
        return {...result,pluginData:undefined}
      })
    }}]
    build=require('esbuild').build
    if(!lstatSync(parserEntry).isFile())throw Error('Expected parser adapter file')
  }
  for(const pkg of [compiler,...(packages??[])]){
    const inside=relative(realpathSync(pkg.root),target)
    if(!inside||(!inside.startsWith('..'+ '/')&&!isAbsolute(inside)&&inside!=='..'))throw Error('Destination must be outside installed dependencies')
  }
  mkdirSync(target)
  const compilerOut=join(target,'compiler');mkdirSync(compilerOut)
  copyFileSync(join(compiler.root,'esbuild.wasm'),join(compilerOut,'esbuild.wasm'))
  writeFileSync(join(compilerOut,'artifact.json'),JSON.stringify(compilerArtifact,null,2)+'\n',{flag:'wx'})
  mkdirSync(join(compilerOut,'notices'));notices([compiler],join(compilerOut,'notices'))
  const result={directory:target,compiler:{version:compilerArtifact.version,wasmSHA256:compilerArtifact.hashes['esbuild.wasm']}}
  if(binding){
    const output=join(target,'rolldown-parser');mkdirSync(output)
    // Whitespace compaction omits esbuild's installation-path source labels.
    // Keep legal comments and leave identifier/syntax transformations disabled.
    // Deployment bytes must not depend on a consumer's temporary directory.
    const bundled=await build({entryPoints:{worker:resolve(parserEntry),pthread:join(binding.root,'wasi-worker-browser.mjs')},outdir:output,bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',metafile:true,minifyWhitespace:true,minifyIdentifiers:false,minifySyntax:false,legalComments:'inline',plugins})
    const allPackages=new Map(packages.map(pkg=>[pkg.root,pkg]))
    const sources={}
    for(const path of Object.keys(bundled.metafile.inputs)){
      // Only the explicitly supplied adapter is ours. Other files, even in the
      // same installed package, must still pass dependency validation below.
      if(realpathSync(resolve(path))===realpathSync(parserEntry))continue
      let root=dirname(resolve(path))
      while(root!==dirname(root)){
        if(existsSync(join(root,'package.json'))){
          const manifest=readJSON(join(root,'package.json'))
          if(root.includes('node_modules')){
            if(requiredDependencies[manifest.name]!==manifest.version)throw Error('Unsupported bundled dependency version: '+manifest.name+'@'+manifest.version)
            if(realpathSync(root)!==pinnedPackages.get(manifest.name)?.root)throw Error('Bundled dependency is not the pinned direct package: '+manifest.name)
            allPackages.set(root,{root,manifest})
            const key=manifest.name+'/'+relative(root,resolve(path)),digest=hash(readFileSync(resolve(path)))
            if(parserInputs.inputs[key]&&parserInputs.inputs[key]!==digest)throw Error('Bundled parser input hash mismatch: '+key)
            if(sources[key]&&sources[key]!==digest)throw Error('Conflicting bundled parser input: '+key)
            sources[key]=digest
          }
          break
        }
        root=dirname(root)
      }
    }
    for(const file of bundled.outputFiles)writeFileSync(file.path,file.contents,{flag:'wx'})
    copyFileSync(join(binding.root,'rolldown-binding.wasm32-wasi.wasm'),join(output,'parser.wasm'))
    const assets=Object.fromEntries(['worker.js','pthread.js','parser.wasm'].map(name=>[name,hash(readFileSync(join(output,name)))]))
    const metadata={version:binding.manifest.version,adapterSHA256:hash(readFileSync(parserEntry)),inputs:parserInputs.inputs,sources,assets}
    writeFileSync(join(output,'artifact.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'})
    mkdirSync(join(output,'notices'));notices([...allPackages.values()],join(output,'notices'))
    result.parser=metadata
  }
  return result
}
