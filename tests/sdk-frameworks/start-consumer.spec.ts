import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve,sep,extname} from 'node:path'
import {observeSDKEngines} from '../sdk/engine-evidence'
import {exampleEnginePolicy} from '../../examples/sdk-frameworks/engine-policy.mjs'
import {prepareStrictSplitAssets,strictSDKFile} from './split-assets.mjs'

const root=realpathSync(process.env.SDK_OUTPUT!)
const runtimeRoot=process.env.SDK_RUNTIME_OUTPUT&&realpathSync(process.env.SDK_RUNTIME_OUTPUT)
let split:Awaited<ReturnType<typeof prepareStrictSplitAssets>>
const sdkManifest=JSON.parse(readFileSync(resolve(runtimeRoot||root,runtimeRoot?'runtime-profile.json':'manifest.json'),'utf8'))
const engine=exampleEnginePolicy(sdkManifest)
if(process.env.SDK_NATIVE_COMPILER&&!['0','1'].includes(process.env.SDK_NATIVE_COMPILER))throw Error('SDK_NATIVE_COMPILER must be 0 or 1')
// Match the public framework example. Setting 0 is a deliberate negative probe.
const nativeCompiler=process.env.SDK_NATIVE_COMPILER!=='0'
const hosting=JSON.parse(readFileSync(resolve(runtimeRoot||root,'preview-host/hosting.json'),'utf8'))
const files:Record<string,string>={}
const profileMode=process.env.SDK_START_PROFILE??'off'
if(!['off','1','compiler'].includes(profileMode))throw Error('SDK_START_PROFILE must be off, 1, or compiler')
const profile=profileMode!=='off'
for(const name of ['package.json','package-lock.json'])files['/project/'+name]=readFileSync('fixtures/install-start-wasm/'+name,'utf8')
for(const name of ['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx'])files['/project/'+name]=readFileSync('fixtures/start-basic/'+name,'utf8')
files['/project/server.mjs']=`import {createServer} from 'vite';
const server=await createServer({server:{host:'127.0.0.1',port:8516,strictPort:true}});await server.listen();console.log('START_READY');`
if(profile)files['/diagnostics/.keep']=''
if(profileMode==='1'){
  files['/project/vite-transform-profiler.mjs']=readFileSync('tests/fixtures/vite-transform-profiler.mjs','utf8')
  files['/project/server.mjs']=`import {createServer} from 'vite';import {transformProfiler} from './vite-transform-profiler.mjs';
const server=await createServer({plugins:[transformProfiler('/diagnostics/vite-transform-profile.json')],server:{host:'127.0.0.1',port:8516,strictPort:true}});await server.listen();console.log('START_READY');`
}
let owner:Server,previewHost:Server,ownerURL:string,previewOrigin:string
const serverCompilerWorkers:string[]=[]
const listen=async(server:Server)=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`
}
test.beforeAll(async()=>{
  split=await prepareStrictSplitAssets(root,runtimeRoot)
  owner=createServer((req,res)=>{
    if(engine.requiresIsolation){
      res.setHeader('Cross-Origin-Opener-Policy','same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    }
    const path=new URL(req.url!,'http://localhost').pathname
    if(path.endsWith('/workers/browser-compiler.js'))serverCompilerWorkers.push(path)
    if(path==='/app/'){
      res.setHeader('Content-Type','text/html')
      res.end('<div id="preview"></div><script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return
    }
    try{
      if(!path.startsWith('/app/vendor/'))throw Error('outside package')
      const file=strictSDKFile(root,split?.directory,decodeURIComponent(path.slice('/app/vendor/'.length)))
      res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  previewHost=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    const route=hosting.routes.find((route:any)=>route.path===path&&route.method===req.method)
    if(!route){res.writeHead(hosting.fallbackStatus,{'Content-Type':'text/plain',...hosting.fallbackHeaders});res.end('No browser workspace attached');return}
    res.writeHead(200,route.headers);res.end(readFileSync(resolve(split?.previewHostDirectory??resolve(root,'preview-host'),route.file)))
  })
  ownerURL=await listen(owner)+'/app/'
  previewOrigin=await listen(previewHost)
})
test.afterAll(async()=>{for(const server of [owner,previewHost])await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

for(const saveResume of [false,true])test(saveResume?'installed Start survives offline reload with SSR, hydration, POST, navigation and route HMR':'built SDK runs installed Start plugin, SSR, hydration, POST server function, navigation and route HMR',async({page,request,context},info)=>{
  if(saveResume)test.setTimeout(240000) // Two unchanged 120-second rounds, including persistence.
  let resume=false
  const compilerRequestStart=serverCompilerWorkers.length
  const rounds:unknown[]=[]
  const resumeExternalRequests:string[]=[]
  if(saveResume)context.on('request',request=>{
    const url=new URL(request.url())
    if(resume&&url.origin!==new URL(ownerURL).origin&&url.origin!==previewOrigin)resumeExternalRequests.push(url.href)
  })
  const diagnostics:string[]=[],requests:string[]=[],stages:string[]=[]
  await page.exposeFunction('sdkStartStage',(stage:string)=>stages.push(stage))
  page.on('pageerror',error=>diagnostics.push(error.message))
  page.on('console',message=>{if(message.type()==='error'){
    const location=message.location()
    diagnostics.push(message.text()+(location.url?` @ ${location.url}:${location.lineNumber}:${location.columnNumber}`:''))
  }})
  page.on('request',request=>requests.push(request.url()))
  expect((await request.get(previewOrigin+'/')).status()).toBe(503)
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const engineEvidence=observeSDKEngines(page,info,root,'experimentalFibers' in engine.options?'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage':'quickjs-als-wasm',[],[],split)
  let failure:unknown
  try{
    for(const restored of saveResume?[false,true]:[false]){
    resume=restored
    if(resume){
      // Match only external traffic so local preview/service-worker routing is untouched.
      await context.route(url=>['http:','https:'].includes(url.protocol)&&![new URL(ownerURL).origin,previewOrigin].includes(url.origin),route=>route.abort())
      await page.reload();await page.waitForFunction(()=>Boolean((window as any).sdk))
    }
    const roundStarted=Date.now()
    const ssr=await page.evaluate(async({files,previewOrigin,profile,resume,saveResume,nativeCompiler,engine})=>{
      const {WorkerKernel,WorkerHTTP,WorkerWebSocket,URLPreview}=(window as any).sdk
      const state:any=(window as any).startSDK={logs:[],requestTimings:[]}
      const kernel=state.kernel=new WorkerKernel(resume?{}:files,{assetBaseURL:new URL('/app/vendor/runtime/',location.href).href,...engine.options,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024},...(nativeCompiler?{experimentalCompiler:{maxMemoryPages:1024,timeoutMs:30000,lifetime:'session'}}:{})})
      if(saveResume)state.roundTimer=setTimeout(()=>{state.roundDeadline=true;state.preview?.close();kernel.close()},120000)
      state.store=async(operation:string,value?:unknown)=>{
        const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('sdk-start-resume',1);request.onupgradeneeded=()=>request.result.createObjectStore('workspace');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
        try{return await new Promise<any>((resolve,reject)=>{const tx=db.transaction('workspace',operation==='load'?'readonly':'readwrite'),table=tx.objectStore('workspace'),request=operation==='load'?table.get('project'):table.put(value,'project');tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error)})}finally{db.close()}
      }
      if(resume){
        const saved=await state.store('load');if(!saved)throw Error('Missing saved Start workspace')
        await kernel.restore(saved)
        const restored=await kernel.snapshot()
        const paths=Object.keys(saved.files).sort()
        if(JSON.stringify(paths)!==JSON.stringify(Object.keys(restored.files).sort()))throw Error('Restored workspace file paths differ')
        for(const path of paths){const before=saved.files[path],after=restored.files[path];if(before.length!==after.length||before.some((byte:number,index:number)=>byte!==after[index]))throw Error('Restored bytes differ: '+path)}
        for(const key of ['directories','symlinks','fileModes','directoryModes']){
          const normalize=(value:any)=>Array.isArray(value)?[...value].sort():value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value
          if(JSON.stringify(normalize(saved[key]))!==JSON.stringify(normalize((restored as any)[key])))throw Error('Restored workspace metadata differs: '+key)
        }
        if(!(await kernel.readText('/project/src/routes/about.tsx')).includes('Edited route'))throw Error('Saved edit was not restored')
        state.byteExactRestore=true
        state.install={skipped:true,reason:'offline snapshot restore'}
      }else{
        await (window as any).sdkStartStage('install')
        state.install=await kernel.install({cwd:'/project',ignoreScripts:true})
      }
      if(profile&&!resume){
        const compilerPath='/project/node_modules/esbuild/lib/main.js'
        const serviceMarker='let sendRequest = (refs, value, callback) => {'
        const original=await kernel.readText(compilerPath)
        if(original.split(serviceMarker).length!==2)throw Error('Unexpected esbuild service timing integration site')
        await kernel.writeText(compilerPath,original.replace(serviceMarker,`const serviceEvents=[];${serviceMarker}
          const event={command:value.command,flags:value.flags,entries:value.entries,start:performance.now()};
          if(serviceEvents.length<512)serviceEvents.push(event);
          const save=()=>require('node:fs').writeFileSync('/diagnostics/compiler-service.json',JSON.stringify(serviceEvents));
          save();const originalCallback=callback;callback=(...args)=>{event.end=performance.now();event.error=args[0]?String(args[0]):undefined;save();return originalCallback(...args)};
        `))
      }
      await (window as any).sdkStartStage('spawn')
      const child=state.child=await kernel.spawn('node',['server.mjs'],{cwd:'/project',guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:256*1024*1024,timeoutMs:30000})
      let output=''
      for(;;){
        const event=await child.next()
        if(event?.type==='stdout'||event?.type==='stderr'){const text=new TextDecoder().decode(event.bytes);state.logs.push(text);output+=text}
        if(output.includes('START_READY'))break
        if(!event||event.type==='exit')throw Error('Start startup failed: '+output)
      }
      state.drain=(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr'){if(state.logs.length<1000)state.logs.push(new TextDecoder().decode(event.bytes))}else break}}catch(error){state.logs.push(String(error))}})()
      const http=new WorkerHTTP(kernel,8516)
      const fetchHTTP=async(request:Request)=>{
        if(!profile)return http.fetch(request)
        const event:any={url:request.url,method:request.method,start:performance.now()}
        if(state.requestTimings.length<512)state.requestTimings.push(event)
        try{
          const response=await http.fetch(request)
          event.headers=performance.now();event.status=response.status
          return response
        }catch(error){event.error=String(error);event.end=performance.now();throw error}
      }
      await (window as any).sdkStartStage('SSR request')
      const response=await fetchHTTP(new Request(previewOrigin+'/'))
      state.ssr={status:response.status,html:await response.text()}
      if(response.status!==200)throw Error('Start SSR failed: '+JSON.stringify(state.ssr))
      await (window as any).sdkStartStage('SSR returned 200, mounting preview')
      state.preview=await URLPreview.mount(document.querySelector('#preview'),{
        origin:previewOrigin,server:{fetch:async(request:Request)=>{
          state.logs.push('PREVIEW_REQUEST '+request.url)
          const response=await fetchHTTP(request)
          state.logs.push('PREVIEW_RESPONSE '+response.status+' '+request.url)
          return response
        }},connectWebSocket:(url:string,protocols:string[])=>WorkerWebSocket.connect(kernel,8516,previewOrigin,url,protocols),
      })
      await (window as any).sdkStartStage('preview mounted')
      return state.ssr
    },{files,previewOrigin,profile,resume,saveResume,nativeCompiler,engine})
    await info.attach('sdk-start-ssr.html',{body:ssr.html,contentType:'text/html'})
    expect(ssr.status).toBe(200)
    expect(ssr.html).toContain('Bare-bones Start')
    expect(ssr.html).toContain('TanStack Start rendered inside the browser runtime.')
    const preview=page.frameLocator('#preview iframe')
    await expect(preview.locator('main[data-hydrated="true"]')).toBeVisible({timeout:90000})
    stages.push('hydration effect committed')
    await expect(preview.locator('#start-count')).toHaveText('Count: 0')
    await preview.locator('#start-count').click({timeout:10000})
    await expect(preview.locator('#start-count')).toHaveText('Count: 1')
    stages.push('client counter updated')
    await preview.locator('#server-call').click()
    await expect(preview.locator('#server-reply')).toContainText('"method":"POST"')
    stages.push('POST server function completed')
    expect(await preview.locator('body').evaluate(()=>{try{void parent.document.body;return false}catch{return true}})).toBe(true)
    await preview.locator('body').evaluate(()=>{(window as any).sdkStartDocument='original'})
    await preview.locator('#about-link').click()
    await expect(preview.locator('#about-title')).toHaveText(resume?'Edited route':'Second route')
    expect(await preview.locator('body').evaluate(()=>(window as any).sdkStartDocument)).toBe('original')
    await page.evaluate(async resume=>{
      const kernel=(window as any).startSDK.kernel,path='/project/src/routes/about.tsx'
      await kernel.writeText(path,(await kernel.readText(path)).replace(resume?'Edited route':'Second route',resume?'Resumed route':'Edited route'))
    },resume)
    await expect(preview.locator('#about-title')).toHaveText(resume?'Resumed route':'Edited route')
    expect(await preview.locator('body').evaluate(()=>(window as any).sdkStartDocument)).toBe('original')
    stages.push('navigation and document-preserving route HMR completed')
    const ownerOrigin=new URL(ownerURL).origin
    expect(requests.filter(url=>url.startsWith(ownerOrigin+'/')&&!url.startsWith(ownerURL))).toEqual([])
    await info.attach('sdk-start-preview.png',{body:await page.screenshot(),contentType:'image/png'})
    if(saveResume){
      const persisted=await page.evaluate(async resume=>{
        const state=(window as any).startSDK
        state.preview.close();await state.child.dispose();await state.drain
        const resources=await state.kernel.resources()
        const snapshot=await state.kernel.snapshot()
        if(!resume)await state.store('save',snapshot)
        clearTimeout(state.roundTimer)
        state.kernel.close()
        const shutdown=state.kernel.shutdown
        if(!shutdown)throw Error('Kernel shutdown acknowledgement is missing')
        await shutdown
        return {resources,paths:Object.keys(snapshot.files??{}),resume,byteExactRestore:state.byteExactRestore,shutdown:{acknowledged:true},roundDeadline:!!state.roundDeadline}
      },resume)
      expect(persisted.resources.processes).toEqual({active:0,retained:0})
      expect(persisted.resources.network).toEqual({handles:0,listeners:0,details:[]})
      expect(persisted.roundDeadline).toBe(false)
      expect(persisted.shutdown).toEqual({acknowledged:true})
      if(resume)expect(persisted.byteExactRestore).toBe(true)
      rounds.push(persisted)
      await info.attach(resume?'sdk-start-resumed.json':'sdk-start-saved.json',{body:JSON.stringify(persisted),contentType:'application/json'})
      expect(resumeExternalRequests).toEqual([])
      expect(Date.now()-roundStarted).toBeLessThan(120000)
    }
    expect(diagnostics,'Start workflow must not hide owner or preview errors').toEqual([])
    if(nativeCompiler)expect(serverCompilerWorkers.length-compilerRequestStart).toBeGreaterThanOrEqual(resume?2:1)
    }
  }catch(error){failure=error;throw error}finally{
    try{
    const state=await page.evaluate(async profile=>{
      const state=(window as any).startSDK
      const profiles:Record<string,unknown>={}
      if(profile&&state?.kernel){
        for(const name of ['vite-transform-profile.json','compiler-service.json']){
          try{profiles[name]=JSON.parse(await state.kernel.readText('/diagnostics/'+name))}
          catch(error){profiles[name]={captureError:String(error)}}
        }
      }
      return {install:state?.install,ssr:state?.ssr,logs:state?.logs,previewRequests:state?.preview?.requests,previewDiagnostics:state?.preview?.diagnostics,
        ...(profile?{profiles,jobProfile:state?.kernel?.jobProfile,requestTimings:state?.requestTimings}:{}),
      }
    },profile).catch(error=>({observationError:String(error)}))
    const cleanup=await page.evaluate(async()=>{
      const state=(window as any).startSDK
      clearTimeout(state?.roundTimer);state?.preview?.close();state?.kernel?.close()
      const shutdown=state?.kernel?.shutdown
      if(!shutdown)throw Error('Kernel shutdown acknowledgement is missing')
      await shutdown
      return {acknowledged:true}
    }).catch(error=>({error:String(error)}))
    const evidencePath=info.outputPath('sdk-start-diagnostics.json')
    await writeFile(evidencePath,JSON.stringify({
      ...split?.evidence,
      profile,profileMode,nativeCompiler,engine,serverCompilerWorkers:serverCompilerWorkers.slice(compilerRequestStart),saveResume,resume,rounds,resumeExternalRequests,
      lockfileSHA256:createHash('sha256').update(files['/project/package-lock.json']).digest('hex'),
      stages,diagnostics,requests,state,cleanup,
      failure:failure instanceof Error?{name:failure.name,message:failure.message,stack:failure.stack}:failure??('error'in cleanup?{message:cleanup.error}:undefined),
    },null,2))
    await info.attach('sdk-start-diagnostics.json',{path:evidencePath,contentType:'application/json'})
    if(!failure&&'error'in cleanup)throw Error(cleanup.error)
    }finally{try{await engineEvidence.flush()}catch(error){if(!failure)throw error}}
  }
  await expect(page.locator('iframe')).toHaveCount(0)
})
