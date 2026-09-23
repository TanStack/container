import {build} from 'esbuild'
import {builtinModules} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {workloadCases,entrySource} from './workload-cases.mjs'
import {collectInstalledClosure} from './collect-installed-closure.mjs'

const root=fileURLToPath(new URL('../fixtures/workloads/',import.meta.url))
const output=fileURLToPath(new URL('../public/workloads/',import.meta.url))
const lock=await readFile(path.join(root,'package-lock.json'))
const packageJSON=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'))
await mkdir(output,{recursive:true})
const externals=[...new Set(builtinModules.flatMap(name=>[name,'node:'+name.replace(/^node:/,'')]))]
const marker='__WORKLOAD_RESULT__'
const onlyArgument=process.argv.slice(2).find(arg=>arg.startsWith('--only='))
const selected=onlyArgument?new Set(onlyArgument.slice(7).split(',')):undefined
if(selected)for(const id of selected)if(!workloadCases.some(fixture=>fixture.id===id))throw Error('Unknown fixture: '+id)

async function reference(directory,seed){
  await writeFile(path.join(directory,'input.json'),JSON.stringify({value:seed}))
  const bootstrap=`globalThis.__workloadRoot=${JSON.stringify(directory)};await import(${JSON.stringify(path.join(directory,'main.mjs'))})`
  const bootstrapPath=path.join(directory,'reference-bootstrap.mjs')
  await writeFile(bootstrapPath,bootstrap)
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[bootstrapPath],{cwd:directory,stdio:['ignore','pipe','pipe'],detached:true,
      env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',ASTRO_TELEMETRY_DISABLED:'1'}})
    let stdout='',stderr='',timedOut=false
    // Node references close their own services. Only a timed-out reference is
    // signaled. A reaped process group must not be signaled after normal exit.
    const stop=()=>{if(!Number.isSafeInteger(child.pid)||child.pid<1)return;try{process.kill(-child.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}}
    const timer=setTimeout(()=>{timedOut=true;stop()},45000)
    child.stdout.on('data',data=>{stdout=(stdout+data).slice(-64000)})
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-12000)})
    child.on('error',error=>{clearTimeout(timer);resolve({status:'error',error:String(error)})})
    child.on('close',code=>{
      clearTimeout(timer)
      const results=stdout.split('\n').filter(x=>x.startsWith(marker))
      resolve({status:code===0&&results.length===1&&!timedOut?'pass':'error',exitCode:code,timedOut,
        value:results.length===1?JSON.parse(results[0].slice(marker.length)):null,stderr,stdout})
    })
  })
}

const manifest={schema:1,generatedAt:new Date().toISOString(),node:process.version,
  lockSHA256:createHash('sha256').update(lock).digest('hex'),packages:packageJSON.dependencies,
  preparation:'Host-installed dependencies. Astro build copies its complete installed dependency closure; other cases collect a static source graph with host esbuild. See each preparation record for scope. Not a browser package installation test.',cases:[]}
const previous=selected?JSON.parse(await readFile(path.join(output,'manifest.json'),'utf8')):undefined
if(previous&&previous.lockSHA256!==manifest.lockSHA256)throw Error('Fixture lock changed, prepare the full suite')
for(const fixture of workloadCases){
  if(selected&&!selected.has(fixture.id)){
    const retained=previous.cases.find(row=>row.id===fixture.id)
    if(!retained)throw Error('Missing prior fixture, prepare the full suite: '+fixture.id)
    manifest.cases.push(retained);continue
  }
  console.log('Prepare',fixture.id)
  const directory=fixture.referenceProject?path.join(root,'projects',fixture.referenceProject):path.join(root,'generated',fixture.id)
  await mkdir(directory,{recursive:true})
  await writeFile(path.join(directory,'main.mjs'),entrySource(fixture))
  await writeFile(path.join(directory,'input.json'),JSON.stringify({value:3}))
  for(const [file,contents] of Object.entries(fixture.files??{})){
    const target=path.join(directory,file.slice(1));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,contents)
  }
  if(fixture.generatedSvelte){
    const compiler=await import(path.join(root,'node_modules/svelte/compiler/index.js'))
    const {compile}=compiler.default??compiler
    const component=compile('<script>export let value;</script><h1>Value {value}</h1>',{generate:'server',filename:'Component.svelte'})
    await writeFile(path.join(directory,'Component.js'),component.js.code)
  }
  if(fixture.id==='next'){
    await mkdir(path.join(directory,'pages'),{recursive:true})
    await writeFile(path.join(directory,'pages/index.jsx'),'export default function Page(){return <h1>Fixture</h1>}')
    await writeFile(path.join(directory,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{next:packageJSON.dependencies.next,react:packageJSON.dependencies.react,'react-dom':packageJSON.dependencies['react-dom']}}))
  }
  if(fixture.referenceReplace)await writeFile(path.join(directory,'main.mjs'),entrySource(fixture).replace(...fixture.referenceReplace))
  const row={id:fixture.id,group:fixture.group,scope:fixture.scope,adaptation:fixture.adaptation??null,execution:fixture.execution??'bundle',
    referenceAdaptation:fixture.referenceReplace??null,
    reference:fixture.nodeReference===false?{status:'not-run',reason:'Separate browser-runtime/full-server boundary probe'}:await reference(directory,3),
    editedReference:fixture.nodeReference===false?{status:'not-run'}:await reference(directory,7)}
  await writeFile(path.join(directory,'input.json'),JSON.stringify({value:3}))
  await writeFile(path.join(directory,'main.mjs'),entrySource(fixture))
  try{
    if(fixture.id==='astro-build'){
      const {files,preparation}=await collectInstalledClosure(root.replace(/\/$/,''),['astro'])
      for(const name of ['main.mjs','input.json'])files['/'+name]={base64:(await readFile(path.join(directory,name))).toString('base64')}
      for(const [name,contents] of Object.entries(fixture.files??{}))files[name]={base64:Buffer.from(contents).toString('base64')}
      const sorted=Object.fromEntries(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0))
      const graphJSON=JSON.stringify({files:sorted,preparation})
      const sha256=createHash('sha256').update(graphJSON).digest('hex')
      const asset=fixture.id+'.'+sha256+'.json'
      await writeFile(path.join(output,asset),graphJSON)
      await writeFile(path.join(output,fixture.id+'.json'),graphJSON)
      row.preparation={...preparation,status:'ready',fileCount:Object.keys(files).length,bytes:Object.values(files).reduce((sum,file)=>sum+Buffer.from(file.base64,'base64').length,0),sha256,asset}
      manifest.cases.push(row)
      continue
    }
    const captured=new Set([path.join(directory,'main.mjs'),path.join(directory,'input.json')])
    let discoveryError
    const discovery=await build({absWorkingDir:root,entryPoints:[path.join(directory,'main.mjs')],bundle:true,write:false,
      metafile:true,format:'esm',platform:fixture.execution==='modules'?'node':'browser',target:'es2022',external:externals,
      conditions:fixture.execution==='modules'?['node']:['worker','browser'],mainFields:fixture.execution==='modules'?['main']:['browser','module','main'],logLevel:'silent',loader:{'.wasm':'binary','.node':'binary'},
      plugins:[{name:'capture-sources',setup(b){b.onLoad({filter:/.*/,namespace:'file'},args=>{captured.add(args.path)})}}],
    }).catch(error=>{discoveryError=error.errors?.map(e=>e.text)??[String(error)];return {warnings:[]}})
    const files={}
    const virtualName=file=>file.startsWith(directory+path.sep)?'/'+path.relative(directory,file).split(path.sep).join('/')
      :file.startsWith(root)?'/'+path.relative(root,file).split(path.sep).join('/')
      :file.includes('/node_modules/')?file.slice(file.indexOf('/node_modules/'))
      :'/../'+file
    const add=async file=>{
      const key=virtualName(file)
      if(key.includes('/../')||key.startsWith('/..'))throw Error('Source escaped isolated fixture root: '+file)
      if(files[key])return
      const bytes=await readFile(file)
      files[key]={base64:bytes.toString('base64')}
    }
    for(const file of captured){
      try{await add(file)}catch(error){
        // esbuild reports disabled browser-map files without an extension.
        // Retain the actual source when it exists, never synthesize a shim.
        if(error.code!=='ENOENT')throw error
        try{await add(file+'.js')}catch(nested){if(nested.code!=='ENOENT')throw nested}
      }
      // Include real package metadata so the browser performs package resolution.
      for(let parent=path.dirname(file);parent.includes('/node_modules/')||parent.startsWith(directory);parent=path.dirname(parent)){
        try{await add(path.join(parent,'package.json'))}catch(error){if(error.code!=='ENOENT')throw error}
      }
    }
    // A Node program can resolve data dynamically. This static graph does not
    // pretend to discover those accesses. Missing assets are reported as gaps.
    for(const [name,contents] of Object.entries(fixture.files??{}))files[name]={base64:Buffer.from(contents).toString('base64')}
    const graphJSON=JSON.stringify({files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0))})
    const sha256=createHash('sha256').update(graphJSON).digest('hex')
    const asset=fixture.id+'.'+sha256+'.json'
    await writeFile(path.join(output,asset),graphJSON)
    row.preparation={status:'ready',fileCount:Object.keys(files).length,bytes:Object.values(files).reduce((sum,file)=>sum+Buffer.from(file.base64,'base64').length,0),
      sha256,asset,warnings:discovery.warnings.map(x=>x.text),discoveryError,
      graph:discoveryError?'partial, discovery failed; missing modules may be preparation gaps':'static graph, runtime-discovered assets excluded'}
  }catch(error){row.preparation={status:'blocked',error:String(error),errors:error.errors?.map(e=>e.text)}}
  manifest.cases.push(row)
}
await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2))
await mkdir(new URL('../reports/',import.meta.url),{recursive:true})
await writeFile(new URL('../reports/workload-preparation.json',import.meta.url),JSON.stringify(manifest,null,2))
console.log(manifest.cases.map(row=>`${row.id}: Node ${row.reference.status}, graph ${row.preparation.status}`).join('\n'))
