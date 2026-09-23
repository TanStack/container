import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync,readdirSync,writeFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve,sep,extname,relative} from 'node:path'
import {observeSDKEngines} from '../sdk/engine-evidence'
import {startSnapshotStore,fingerprintStartWorkspace} from './start-workspace-persistence'

// Preserve the original baseline and make the separate portable graph explicit.
const portable=process.env.SDK_SITE_PROFILE==='portable'
if(process.env.SDK_SITE_PROFILE&&!portable)throw Error('SDK_SITE_PROFILE must be portable or unset')
const threaded=process.env.SDK_SITE_THREADED==='1'
if(process.env.SDK_SITE_THREADED&&!threaded)throw Error('SDK_SITE_THREADED must be 1 or unset')
const nativeParser=process.env.SDK_SITE_NATIVE_PARSER==='1'
if(process.env.SDK_SITE_NATIVE_PARSER&&!nativeParser)throw Error('SDK_SITE_NATIVE_PARSER must be 1 or unset')
const captureModules=process.env.SDK_SITE_DIAGNOSTICS==='1'
const httpDiagnostics=process.env.SDK_SITE_HTTP_DIAGNOSTICS==='1'
if(process.env.SDK_SITE_HTTP_DIAGNOSTICS&&!httpDiagnostics)throw Error('SDK_SITE_HTTP_DIAGNOSTICS must be 1 or unset')
const resumeWorkspace=process.env.SDK_SITE_RESUME==='1'
if(process.env.SDK_SITE_RESUME&&!resumeWorkspace)throw Error('SDK_SITE_RESUME must be 1 or unset')
const hosted=process.env.SDK_SITE_HOSTED==='1'
if(process.env.SDK_SITE_HOSTED&&!hosted)throw Error('SDK_SITE_HOSTED must be 1 or unset')
if(hosted&&!resumeWorkspace)throw Error('Hosted site acceptance requires save and resume')
const runtimeDiagnostics=process.env.SDK_SITE_RUNTIME_DIAGNOSTICS==='1'
if(process.env.SDK_SITE_RUNTIME_DIAGNOSTICS&&!runtimeDiagnostics)throw Error('SDK_SITE_RUNTIME_DIAGNOSTICS must be 1 or unset')
if(process.env.SDK_SITE_DIAGNOSTICS&&!captureModules)throw Error('SDK_SITE_DIAGNOSTICS must be 1 or unset')
if(threaded&&!portable)throw Error('Threaded site acceptance requires the explicit portable graph')
const previewStartupBudgetMs=120000
const ownerPolicy={maxBytes:256*1024*1024,timeoutMs:120000,workspace:{maxBytes:128*1024*1024},experimentalCompiler:{maxMemoryPages:1024,timeoutMs:30000,lifetime:'session'},...(nativeParser?{experimentalRolldownParser:{timeoutMs:30000,maxSourceBytes:16*1024*1024}}:{}),...(threaded?{experimentalFibers:true,workerMaxBytes:64*1024*1024,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true}}:{})}
const root=realpathSync(process.env.SDK_OUTPUT!)
const sdkManifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
if(nativeParser&&(!sdkManifest.experimentalRolldownParser||sdkManifest.experimentalRolldownParser.version!=='1.2.9'||sdkManifest.experimentalRolldownParser.enabledByDefault!==false))throw Error('Native parser acceptance requires the packaged opt-in Rolldown 1.2.9 artifact')
const source=realpathSync(process.env.SDK_SITE_EXAMPLE??'../router/examples/react/start-counter')
const hosting=JSON.parse(readFileSync(resolve(root,'preview-host/hosting.json'),'utf8'))
const files:Record<string,string>={}
const hashes:Record<string,string>={}
function collect(directory:string){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(entry.name==='node_modules'||entry.name==='.git'||entry.name==='dist'||entry.name==='.output')continue
    const path=resolve(directory,entry.name)
    if(entry.isDirectory()){collect(path);continue}
    if(!entry.isFile())throw Error('Unexpected non-file in example: '+path)
    const name=relative(source,path),bytes=readFileSync(path)
    files['/project/'+name]=bytes.toString('utf8')
    hashes[name]=createHash('sha256').update(bytes).digest('hex')
  }
}
collect(source)
const pinnedFixture=resolve(portable?'fixtures/site-start-counter-portable':'fixtures/site-start-counter')
const provenance=JSON.parse(readFileSync(resolve(pinnedFixture,'provenance.json'),'utf8'))
if(hashes['package.json']!==provenance.sourceSHA256)throw Error('Real site manifest changed; regenerate and review its acceptance lockfile')
const fixtureManifest=readFileSync(resolve(pinnedFixture,'package.json'))
if(portable){
  const original=JSON.parse(files['/project/package.json'])
  const expected={...original,dependencies:{...original.dependencies,...provenance.graphChanges.dependencies},overrides:provenance.graphChanges.overrides}
  if(JSON.stringify(JSON.parse(fixtureManifest.toString()))!==JSON.stringify(expected))throw Error('Portable manifest differs from declared graph changes')
  files['/project/package.json']=fixtureManifest.toString()
}else if(createHash('sha256').update(fixtureManifest).digest('hex')!==provenance.sourceSHA256)throw Error('Acceptance fixture manifest does not match recorded source')
const processEnv:Record<string,string>=provenance.env??{}
files['/project/package-lock.json']=readFileSync(resolve(pinnedFixture,'package-lock.json'),'utf8')
const lockfileSHA256=createHash('sha256').update(files['/project/package-lock.json']).digest('hex')
files['/project/SDK-SOURCE-LICENSE.txt']=readFileSync(resolve(source,'../../../LICENSE'),'utf8')
files['/project/sdk-acceptance-server.mjs']=`function describe(error,depth=0){
  if(depth>3)return {message:'Cause depth limit'};
  const result={};
  for(const key of ['message','code','stack']){try{if(error?.[key]!==undefined)result[key]=String(error[key]).slice(0,4000)}catch{}}
  try{if(error?.cause!==undefined)result.cause=describe(error.cause,depth+1)}catch{}
  return result;
}
try{
  ${captureModules?`const moduleLoads=[],moduleEdges=[];
  let moduleLoadChars=0,moduleLoadsTruncated=false,moduleEdgesTruncated=false;
  const observedURL=url=>typeof url==='string'&&url.includes('/@tanstack/router-core/')&&/\\/(?:router|load-server)\\.js|\\/isServer\\//.test(url);
  const {registerHooks}=await import('node:module');
  registerHooks({
    resolve(specifier,context,nextResolve){
      const result=nextResolve(specifier,context);
      if(observedURL(context.parentURL)||observedURL(result.url)){
        if(moduleEdges.length<128)moduleEdges.push({specifier,parentURL:context.parentURL,url:result.url,format:result.format,conditions:context.conditions});
        else moduleEdgesTruncated=true;
      }
      return result;
    },
    load(url,context,nextLoad){
      const result=nextLoad(url,context);
      if(observedURL(url)){
        const source=typeof result.source==='string'?result.source:result.source===undefined?undefined:new TextDecoder().decode(result.source);
        if(moduleLoads.length<16&&moduleLoadChars+(source?.length??0)<=524288){moduleLoads.push({url,format:result.format,source});moduleLoadChars+=source?.length??0}
        else moduleLoadsTruncated=true;
      }
      return result;
    }
  });`:''}
  const {createServer}=await import('vite');
  const server=await createServer({server:{host:'127.0.0.1',strictPort:true}});
  ${captureModules?`const fs=await import('node:fs');
  const originalError=console.error;
  console.error=(...args)=>{
    originalError(...args);
    try{
      const graph=server.environments.ssr.moduleGraph,modules=[];
      for(const entry of graph.idToModuleMap.values()){
        if(!entry.id?.includes('/@tanstack/router-core/'))continue;
        if(!/\\/(?:router|load-server)\\.js|\\/isServer\\//.test(entry.id))continue;
        const code=entry.ssrTransformResult?.code??entry.transformResult?.code;
        modules.push({id:entry.id,url:entry.url,code:typeof code==='string'?code.slice(0,262144):null});
      }
      const diagnostic={errors:args.map(error=>describe(error)),modules,moduleLoads,moduleEdges,moduleLoadChars,moduleLoadsTruncated,moduleEdgesTruncated};
      const save=()=>fs.writeFileSync('/project/sdk-failure-modules.json',JSON.stringify(diagnostic));
      save();
      import('@tanstack/router-core/isServer').then(namespace=>{
        diagnostic.external={keys:Object.keys(namespace),loadServerRoute:typeof namespace.loadServerRoute,isServer:namespace.isServer,resolveAvailable:typeof import.meta.resolve==='function'};
        if(diagnostic.external.resolveAvailable){
          const resolved=import.meta.resolve('@tanstack/router-core/isServer');
          Object.assign(diagnostic.external,{resolved,source:fs.readFileSync(new URL(resolved),'utf8')});
        }
        save();
      }).catch(error=>{diagnostic.external={error:describe(error)};save()});
    }catch(error){originalError('SDK diagnostic capture failed: '+String(error))}
  };`:''}
  await server.listen();console.log('SITE_START_READY');
}catch(error){console.error('SITE_START_CAUSE '+JSON.stringify(describe(error)).slice(0,20000));throw error;}`
let owner:Server,previewHost:Server,runtimeHost:Server|undefined,ownerURL:string,previewOrigin:string,runtimeHostURL:string|undefined
const listen=async(server:Server)=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`
}
test.beforeAll(async()=>{
  if(hosted){
    runtimeHost=createServer((req,res)=>{
      res.setHeader('Cross-Origin-Opener-Policy','same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
      res.setHeader('Cross-Origin-Resource-Policy','cross-origin')
      res.setHeader('Origin-Agent-Cluster','?1')
      const path=new URL(req.url!,'http://localhost').pathname
      try{
        const relativePath=path==='/'?'kernel-host.html':decodeURIComponent(path.slice(1))
        const file=realpathSync(resolve(root,relativePath))
        if(!file.startsWith(root+sep))throw Error('outside package')
        res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
        res.end(readFileSync(file))
      }catch{res.statusCode=404;res.end()}
    })
    runtimeHostURL=await listen(runtimeHost)+'/kernel-host.html'
  }
  owner=createServer((req,res)=>{
    if(nativeParser||threaded){
      res.setHeader('Cross-Origin-Opener-Policy','same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    }
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/app/'){
      res.setHeader('Content-Type','text/html')
      res.end('<div id="preview"></div><script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return
    }
    try{
      if(!path.startsWith('/app/vendor/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice('/app/vendor/'.length))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  previewHost=createServer((req,res)=>{
    if(nativeParser||threaded){
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
      res.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    }
    const path=new URL(req.url!,'http://localhost').pathname
    const route=hosting.routes.find((route:any)=>route.path===path&&route.method===req.method)
    if(!route){res.writeHead(hosting.fallbackStatus);res.end('No browser workspace attached');return}
    res.writeHead(200,route.headers);res.end(readFileSync(resolve(root,'preview-host',route.file)))
  })
  ownerURL=(await listen(owner)).replace('127.0.0.1','localhost')+'/app/'
  previewOrigin=(await listen(previewHost)).replace('127.0.0.1','localhost')
})
test.afterAll(async()=>{for(const server of [owner,previewHost,runtimeHost])if(server)await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

test(portable?'public SDK runs the actual site Start counter with the declared portable compiler graph':'public SDK runs the actual site Start counter without dependency substitutions',async({page},info)=>{
  const stages:string[]=[],diagnostics:string[]=[]
  const stageEvents:Array<{stage:string;status:'started'|'completed'|'failed';at:number;detail?:string}>=[]
  const progressPath=info.outputPath('site-start-counter-progress.json')
  const recordStage=(stage:string,status:'started'|'completed'|'failed',detail?:string)=>{
    const event={stage,status,at:Date.now(),...(detail?{detail:detail.slice(0,2000)}:{})}
    stageEvents.push(event)
    if(stageEvents.length>128)stageEvents.shift()
    if(status==='completed')stages.push(stage)
    // This file is deliberately updated from the Playwright process. It survives
    // a renderer or worker stall that prevents the test's finally block from
    // evaluating any more code in the page.
    writeFileSync(progressPath,JSON.stringify({stageEvents,last:event},null,2))
    if(hosted)console.log('HOSTED_STAGE',stage,status)
  }
  const hostConsole:Array<{type:string;text:string;at:number;location:{url:string;lineNumber:number;columnNumber:number}}>=[]
  if(runtimeDiagnostics||hosted)page.on('console',message=>{hostConsole.push({type:message.type(),text:message.text().slice(0,6000),at:Date.now(),location:message.location()});if(hostConsole.length>32)hostConsole.shift();if(hosted&&message.type()==='error')console.log('HOSTED_CONSOLE_ERROR',message.text())})
  let savedWorkspace:unknown
  const offlineRequests:string[]=[]
  await page.addInitScript(`window.__startSnapshotStore=${startSnapshotStore.toString()};window.__startSnapshotFingerprint=${fingerprintStartWorkspace.toString()};`)
  const previewNavigations:Array<{url:string;at:number}>=[]
  page.on('framenavigated',frame=>{
    if(frame.url().startsWith(previewOrigin+'/')){
      if(hosted)console.log('HOSTED_PREVIEW_NAVIGATION',frame.url())
      previewNavigations.push({url:frame.url(),at:Date.now()})
      if(previewNavigations.length>16)previewNavigations.shift()
    }
  })
  // Observe each document before its parser runs. Retain the actual bootstrap
  // object so its normal deletion cannot be mistaken for never having existed.
  // This does not replace properties, wrap app methods, or change app source.
  await page.addInitScript(({origin})=>{
    if(location.origin!==origin||location.pathname!=='/')return
    const state:any={startedAt:Date.now(),seenBootstrap:false,hydrated:false,streamEnded:false,samples:[]}
    ;(window as any).__siteStartReadiness=state
    ;(window as any).__browserSandboxReadiness=state
    let bootstrap:any,last=''
    const sample=()=>{
      const current=(window as any).$_TSR
      if(current&&typeof current.h==='function'){
        bootstrap=current
        state.seenBootstrap=true
      }
      state.hydrated=bootstrap?.hydrated===true
      state.streamEnded=bootstrap?.streamEnded===true
      state.readyState=document.readyState
      state.bootstrapPresent=Boolean(current)
      const key=JSON.stringify([state.readyState,state.seenBootstrap,state.hydrated,state.streamEnded,state.bootstrapPresent])
      if(key!==last){
        last=key
        state.samples.push({at:Date.now()-state.startedAt,readyState:state.readyState,seenBootstrap:state.seenBootstrap,hydrated:state.hydrated,streamEnded:state.streamEnded,bootstrapPresent:state.bootstrapPresent})
        if(state.samples.length>16)state.samples.shift()
      }
    }
    const observer=new MutationObserver(sample)
    observer.observe(document,{childList:true,subtree:true})
    document.addEventListener('readystatechange',sample)
    const timer=setInterval(sample,20)
    const stop=()=>{observer.disconnect();clearInterval(timer);document.removeEventListener('readystatechange',sample)}
    addEventListener('pagehide',stop,{once:true})
    setTimeout(stop,30000)
    sample()
  },{origin:previewOrigin})
  let mountedDocument:Promise<{status:number;hasBootstrap:boolean}>|undefined
  page.on('response',response=>{
    if(response.url()===previewOrigin+'/'&&response.request().resourceType()==='document'){
      if(hosted)console.log('HOSTED_PREVIEW_RESPONSE',response.status(),response.url())
      mountedDocument=response.text().then(html=>({status:response.status(),hasBootstrap:html.includes('self.$_TSR=')}),()=>({status:response.status(),hasBootstrap:false}))
    }
  })
  const pendingRequests=new Map<unknown,{method:string;url:string}>(),failedRequests:Array<{url:string;error:string|undefined}>=[]
  const requestTimes=new WeakMap<object,number>(),requestTimings:Array<unknown>=[]
  const finishRequest=(request:any,error?:string)=>{
    requestTimings.push({url:request.url(),type:request.resourceType(),startedAt:requestTimes.get(request),finishedAt:Date.now(),error,timing:request.timing()})
    if(requestTimings.length>256)requestTimings.shift()
  }
  let droppedRequests=0
  page.on('request',request=>{requestTimes.set(request,Date.now());if(pendingRequests.size<64)pendingRequests.set(request,{method:request.method(),url:request.url()});else droppedRequests++})
  page.on('requestfinished',request=>{pendingRequests.delete(request);finishRequest(request)})
  page.on('requestfailed',request=>{pendingRequests.delete(request);finishRequest(request,request.failure()?.errorText);failedRequests.push({url:request.url(),error:request.failure()?.errorText});if(failedRequests.length>32)failedRequests.shift()})
  await page.exposeFunction('siteStage',(stage:string,status:'started'|'completed'|'failed'='completed',detail?:string)=>recordStage(stage,status,detail))
  page.on('pageerror',error=>diagnostics.push(error.message))
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const evidence=observeSDKEngines(page,info,root,threaded?'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage':'quickjs-als-wasm',runtimeHostURL?[runtimeHostURL]:[])
  let failure:unknown
  const bootStart=async({files,previewOrigin,runtimeHostURL,hosted,processEnv,ownerPolicy,resume,expectedFingerprint,runtimeDiagnostics,httpDiagnostics}:any)=>{
      const runStage=async<T>(name:string,operation:()=>Promise<T>)=>{
        await (window as any).siteStage(name,'started')
        try{
          const result=await operation()
          await (window as any).siteStage(name,'completed')
          return result
        }catch(error){
          await (window as any).siteStage(name,'failed',String(error))
          throw error
        }
      }
      const {WorkerKernel,HostedKernel,WorkerHTTP,WorkerWebSocket,URLPreview}=(window as any).sdk
      const state:any=(window as any).siteSDK={logs:[]}
      const kernel=state.kernel=await runStage('kernel create',async()=>hosted
        ?await HostedKernel.create(resume?{}:files,{hostURL:runtimeHostURL,kernel:ownerPolicy,container:document.querySelector('#preview')})
        :new WorkerKernel(resume?{}:files,ownerPolicy))
      if(resume){
        await runStage('saved files, dependencies and cache restored without installation',async()=>{
          if(hosted){
            state.restored=await kernel.restoreCheckpoint('sdk-site-start-counter')
            if(state.restored.files!==expectedFingerprint.files||state.restored.bytes!==expectedFingerprint.bytes)throw Error('Restored Start checkpoint differs before spawn')
          }else{
            const snapshot=await (window as any).__startSnapshotStore({operation:'load'})
            if(!snapshot)throw Error('Saved Start workspace is missing after reload')
            await kernel.restore(snapshot)
            state.restored=await (window as any).__startSnapshotFingerprint(await kernel.snapshot())
            if(JSON.stringify(state.restored)!==JSON.stringify(expectedFingerprint))throw Error('Restored Start workspace differs before spawn')
          }
          if(await kernel.readText('/project/count.txt')!=='2')throw Error('Saved counter was not restored')
          if(!(await kernel.readText('/project/src/routes/index.tsx')).includes('Increment {state}?'))throw Error('Saved route edit was not restored')
        })
      }else{
        state.install=await runStage('install',()=>kernel.install({cwd:'/project',ignoreScripts:true}))
      }
      const child:any=state.child=await runStage('spawn',()=>kernel.spawn('node',['sdk-acceptance-server.mjs'],{cwd:'/project',env:processEnv,guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:256*1024*1024,timeoutMs:90000,diagnostics:runtimeDiagnostics}))
      state.exit=child.wait().then((result:unknown)=>{state.result=result},(error:unknown)=>{state.result={error:String(error)}})
      let output=''
      await runStage('server ready',async()=>{for(;;){
          const event=await child.next()
          if(event?.type==='stdout'||event?.type==='stderr'){const text=new TextDecoder().decode(event.bytes);state.logs.push(text);output+=text}
          if(output.includes('SITE_START_READY'))break
          if(!event||event.type==='exit')throw Error('Site Start startup failed: '+output)
        }})
      state.drain=(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')state.logs.push(new TextDecoder().decode(event.bytes));else break}}catch(error){state.logs.push(String(error))}})()
      const rawHTTP=new WorkerHTTP(kernel,3000)
      const http=httpDiagnostics?{fetch:async(request:Request)=>{
        const entry:any={url:request.url,method:request.method,startedAt:Date.now(),bytes:0}
        const entries=state.httpTimings??(state.httpTimings=[])
        entries.push(entry)
        if(entries.length>256)entries.shift()
        try{
          const response=await rawHTTP.fetch(request)
          entry.headersAt=Date.now();entry.status=response.status
          if(!response.body){entry.bodyFinishedAt=Date.now();return response}
          const reader=response.body.getReader()
          const body=new ReadableStream({
            async pull(controller){
              try{
                const result=await reader.read()
                if(result.done){entry.bodyFinishedAt=Date.now();reader.releaseLock();controller.close()}
                else{entry.bytes+=result.value.byteLength;controller.enqueue(result.value)}
              }catch(error){entry.error=String(error);entry.bodyFinishedAt=Date.now();reader.releaseLock();controller.error(error)}
            },
            async cancel(reason){entry.cancelled=String(reason);entry.bodyFinishedAt=Date.now();try{await reader.cancel(reason)}finally{reader.releaseLock()}},
          },{highWaterMark:0})
          return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers})
        }catch(error){entry.error=String(error);entry.bodyFinishedAt=Date.now();throw error}
      }}:rawHTTP
      const response:any=await runStage('SSR response headers',()=>http.fetch(new Request(previewOrigin+'/')))
      state.ssr={status:response.status,html:await runStage('SSR response body',()=>response.text())}
      if(response.status!==200)throw Error('Site SSR failed: '+JSON.stringify(state.ssr))
      state.ssr.buttonText=new DOMParser().parseFromString(state.ssr.html,'text/html').querySelector('button')?.textContent?.replace(/\s+/g,' ').trim()
      if(state.ssr.buttonText!==(resume?'Increment 2?':'Add 1 to 0?'))throw Error('Site SSR did not render the expected counter: '+JSON.stringify(state.ssr))
      if(!state.ssr.html.includes('self.$_TSR='))throw Error('Pinned Start hydration bootstrap marker changed')
      if('experimentalRolldownParser' in ownerPolicy){
        const resources=await kernel.resources()
        state.parserAfterSSR=resources.nativeParser
        if(!(resources.nativeParser?.completedCalls>0))throw Error('SSR did not establish a completed native parser call')
        if(!(resources.nativeParser?.callable?.completed>0))throw Error('SSR did not establish shared-session callable execution')
      }
      state.mountStartedAt=Date.now()
      state.preview=await runStage('mount',async()=>hosted
        ?await kernel.mountPreview(document.querySelector('#preview'),{origin:previewOrigin,port:3000})
        :await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:http,connectWebSocket:(url:string,protocols:string[])=>WorkerWebSocket.connect(kernel,3000,previewOrigin,url,protocols)}))
  }
  const hostedControl=async(expected:string,timeout=previewStartupBudgetMs,interactive=false)=>expect.poll(async()=>page.evaluate(async({expected,interactive})=>{
    const state=await (window as any).siteSDK.preview.inspect()
    const text=state.controls.find((control:{tag:string;text:string})=>control.tag==='button')?.text?.replace(/\s+/g,' ').trim()
    const ready=!interactive||(state.readiness?.seenBootstrap===true&&state.readiness?.hydrated===true&&state.readiness?.streamEnded===true)
    return ready?text:undefined
  },{expected,interactive}),{timeout}).toBe(expected)
  const hostedClick=()=>page.evaluate(async()=>{await (window as any).siteSDK.preview.click('button')})
  const waitStartReady=async(expectedText:string)=>{
    const stage='hydration '+expectedText
    recordStage(stage,'started')
    // Inspection can attach to SSR HTML before its client modules have loaded.
    // Keep readiness inside the owner operation ceiling. Firefox can need
    // several legitimate optimizer reloads before the complete client graph hydrates.
    const remaining=await page.evaluate(budget=>budget-(Date.now()-(window as any).siteSDK.mountStartedAt),previewStartupBudgetMs)
    if(hosted)console.log('HOSTED_READINESS_REMAINING',remaining)
    if(remaining<=0)throw Error('Preview startup budget exhausted before document load')
    // Vite may reload while discovering dependencies. Wait on the current
    // document's observed bootstrap, not load events or an absent global.
    // If observation missed the bootstrap entirely, fail rather than infer ready.
    if(hosted)await hostedControl(expectedText,remaining,true)
    else{
      const previewFrame=await (await page.locator('#preview iframe').elementHandle())!.contentFrame()
      if(!previewFrame)throw Error('Preview frame is unavailable')
      await previewFrame.waitForFunction(expected=>{
        const state=(window as any).__siteStartReadiness
        return state?.seenBootstrap===true&&state.hydrated===true&&state.streamEnded===true&&document.querySelector('button')?.textContent?.replace(/\s+/g,' ').trim()===expected
      },expectedText,{timeout:remaining})
    }
    const deliveredDocument=await mountedDocument
    if(deliveredDocument?.status!==200||!deliveredDocument.hasBootstrap)throw Error('Delivered Start document lacks its expected hydration bootstrap')
    recordStage(stage,'completed')
    recordStage('Start hydration wrapper settled, interaction still required','completed')
  }
  try{
    await page.evaluate(bootStart,{files,previewOrigin,runtimeHostURL,hosted,processEnv,ownerPolicy,resume:false,runtimeDiagnostics,httpDiagnostics})
    const preview=hosted?page.frameLocator('#preview > iframe').frameLocator('iframe[title="Workspace preview"]'):page.frameLocator('#preview iframe')
    await waitStartReady('Add 1 to 0?')
    recordStage('cold app interactions and live edit','started')
    if(hosted){await hostedClick();await hostedControl('Add 1 to 1?')}
    else{await expect(preview.getByRole('button',{name:'Add 1 to 0?'})).toBeVisible();await preview.getByRole('button',{name:'Add 1 to 0?'}).click();await expect(preview.getByRole('button',{name:'Add 1 to 1?'})).toBeVisible()}
    recordStage('server counter persisted and rendered','completed')
    await page.evaluate(async()=>{
      const {kernel}=(window as any).siteSDK
      const path='/project/src/routes/index.tsx'
      const original=await kernel.readText(path)
      const marker='Add 1 to {state}?'
      if(original.split(marker).length!==2)throw Error('Site counter edit target changed')
      await kernel.writeText(path,original.replace(marker,'Increment {state}?'))
    })
    if(hosted)await hostedControl('Increment 1?');else await expect(preview.getByRole('button',{name:'Increment 1?'})).toBeVisible()
    recordStage('route live edit rendered without host reload','completed')
    if(hosted){await hostedClick();await hostedControl('Increment 2?')}
    else{await preview.getByRole('button',{name:'Increment 1?'}).click();await expect(preview.getByRole('button',{name:'Increment 2?'})).toBeVisible()}
    expect(await page.evaluate(async()=>await (window as any).siteSDK.kernel.readText('/project/count.txt'))).toBe('2')
    recordStage('server function and filesystem work after live edit','completed')
    recordStage('cold app interactions and live edit','completed')
    if(resumeWorkspace){
      recordStage('save workspace and stop cold kernel','started')
      const saved=await page.evaluate(async(hosted)=>{
        const state=(window as any).siteSDK
        await state.preview.close()
        await state.child.dispose()
        await state.drain
        const resources=await state.kernel.resources()
        const snapshot=hosted?undefined:await state.kernel.snapshot()
        const fingerprint=hosted?await state.kernel.saveCheckpoint('sdk-site-start-counter'):await (window as any).__startSnapshotFingerprint(snapshot)
        if(!hosted)await (window as any).__startSnapshotStore({operation:'save',snapshot})
        state.kernel.close()
        await state.kernel.shutdown
        return {fingerprint,resources,logs:state.logs,shutdown:true}
      },hosted)
      recordStage('save workspace and stop cold kernel','completed')
      savedWorkspace=saved
      if(hosted){expect(saved.fingerprint.files).toBeGreaterThan(0);expect(saved.fingerprint.bytes).toBeGreaterThan(0)}
      else{expect(saved.fingerprint.packageFiles).toBeGreaterThan(0);expect(saved.fingerprint.cacheFiles).toBeGreaterThan(0)}
      expect(saved.resources.processes.active).toBe(0)
      if(nativeParser)expect(saved.resources.nativeParser.callable.failed).toBe(0)
      const allowedOrigins=new Set([new URL(ownerURL).origin,previewOrigin,...(runtimeHostURL?[new URL(runtimeHostURL).origin]:[])])
      page.context().on('request',request=>{
        const url=new URL(request.url())
        if(['http:','https:'].includes(url.protocol)&&!allowedOrigins.has(url.origin))offlineRequests.push(url.href)
      })
      mountedDocument=undefined
      recordStage('reload owner for offline resume','started')
      await page.reload()
      await page.waitForFunction(()=>Boolean((window as any).sdk))
      recordStage('reload owner for offline resume','completed')
      recordStage('host reloaded, external dependency requests observed','completed')
      await page.evaluate(bootStart,{files:{},previewOrigin,runtimeHostURL,hosted,processEnv,ownerPolicy,resume:true,expectedFingerprint:saved.fingerprint,runtimeDiagnostics,httpDiagnostics})
      await waitStartReady('Increment 2?')
      recordStage('resumed app interactions and live edit','started')
      const resumed=hosted?page.frameLocator('#preview > iframe').frameLocator('iframe[title="Workspace preview"]'):page.frameLocator('#preview iframe')
      if(hosted){await hostedClick();await hostedControl('Increment 3?')}
      else{await resumed.getByRole('button',{name:'Increment 2?'}).click();await expect(resumed.getByRole('button',{name:'Increment 3?'})).toBeVisible()}
      await page.evaluate(async()=>{
        const kernel=(window as any).siteSDK.kernel,path='/project/src/routes/index.tsx'
        const text=await kernel.readText(path),marker='Increment {state}?'
        if(text.split(marker).length!==2)throw Error('Restored route edit target changed')
        await kernel.writeText(path,text.replace(marker,'Resumed {state}?'))
      })
      if(hosted){await hostedControl('Resumed 3?');await hostedClick();await hostedControl('Resumed 4?')}
      else{await expect(resumed.getByRole('button',{name:'Resumed 3?'})).toBeVisible();await resumed.getByRole('button',{name:'Resumed 3?'}).click();await expect(resumed.getByRole('button',{name:'Resumed 4?'})).toBeVisible()}
      expect(await page.evaluate(()=>(window as any).siteSDK.kernel.readText('/project/count.txt'))).toBe('4')
      expect(offlineRequests,'Resume must not attempt dependency downloads').toEqual([])
      if(hosted)await page.evaluate(async()=>{await (window as any).siteSDK.kernel.deleteCheckpoint('sdk-site-start-counter')})
      else await page.evaluate(startSnapshotStore,{operation:'delete' as const})
      recordStage('resumed app interactions and live edit','completed')
      recordStage('saved Start app resumed offline, interacted and live-edited in a fresh kernel','completed')
    }
  }catch(error){failure=error;throw error}finally{
    recordStage('terminal diagnostics and cleanup','started')
    const moduleCaptureWaitError=captureModules&&failure?await page.waitForFunction(async()=>{
      try{return Boolean(JSON.parse(await (window as any).siteSDK.kernel.readText('/project/sdk-failure-modules.json')).external)}catch{return false}
    },undefined,{timeout:3000}).then(()=>undefined,error=>String(error)):undefined
    const state=await page.evaluate(async()=>{const state=(window as any).siteSDK;const moduleDiagnostics=await state?.kernel?.readText('/project/sdk-failure-modules.json').catch(()=>undefined);return {install:state?.install,restored:state?.restored,logs:state?.logs,ssr:state?.ssr,result:state?.result,httpTimings:state?.httpTimings,jobProfile:state?.kernel?.jobProfile,workerLifecycle:state?.kernel?.workerLifecycle,moduleDiagnostics:moduleDiagnostics===undefined?undefined:JSON.parse(moduleDiagnostics),resources:await state?.kernel?.resources().catch((error:unknown)=>({captureError:String(error)}))}}).catch(error=>({captureError:String(error)}))
    const browserRequests={pending:[...pendingRequests.values()],failed:[...failedRequests],droppedRequests,timings:requestTimings}
    const previewReadiness=hosted
      ?[await page.evaluate(async()=>{try{return await (window as any).siteSDK?.preview?.inspect()}catch(error){return {captureError:String(error)}}})]
      :await Promise.all(page.frames().filter(frame=>frame.url().startsWith(previewOrigin+'/')).map(async frame=>({url:frame.url(),state:await frame.evaluate(()=>({ ...((window as any).__siteStartReadiness??{readyState:document.readyState,observerMissing:true}),timeOrigin:performance.timeOrigin,navigation:performance.getEntriesByType('navigation').map(entry=>entry.toJSON()),resources:performance.getEntriesByType('resource').slice(-128).map(entry=>entry.toJSON()),scripts:Array.from(document.scripts).slice(0,16).map(script=>({src:script.src,type:script.type,async:script.async,defer:script.defer}))})).catch(error=>({captureError:String(error)}))})))
    // Runtime totals are emitted before process completion, not before a kernel
    // shutdown acknowledgement. Dispose first when collecting diagnostics.
    const terminalDiagnostics=runtimeDiagnostics?await page.evaluate(async()=>{
      const state=(window as any).siteSDK
      await state?.preview?.close()
      await state?.child?.dispose()
      await state?.drain
      return {jobProfile:state?.kernel?.jobProfile,hostTaskScheduling:state?.kernel?.hostTaskScheduling,workerLifecycle:state?.kernel?.workerLifecycle}
    }).catch(error=>({captureError:String(error)})):undefined
    const cleanup=await page.evaluate(async()=>{const state=(window as any).siteSDK;await state?.preview?.close();state?.kernel?.close();const shutdown=state?.kernel?.shutdown;await shutdown;return {acknowledged:Boolean(shutdown)}}).catch(error=>({error:String(error)}))
    recordStage('terminal diagnostics and cleanup','completed')
    let terminalFailure:unknown
    if(!failure)try{
      if('error' in cleanup)throw Error('Kernel cleanup failed: '+cleanup.error)
      if(runtimeDiagnostics)expect(hostConsole.filter(entry=>entry.type==='error'&&entry.text.includes("worker-src 'none'")),'Closing the preview must not leave a live Vite client attempting worker reconnects').toEqual([])
      if(nativeParser)expect((state as any).resources?.nativeParser?.callable?.failed,'Successful app interactions must not hide failed compiler callbacks').toBe(0)
    }catch(error){terminalFailure=error;failure=error}
    const diagnosticsPath=info.outputPath('site-start-counter-diagnostics.json')
    await writeFile(diagnosticsPath,JSON.stringify({source,hashes,provenance,lockfileSHA256,threaded,nativeParser,captureModules,runtimeDiagnostics,hostConsole,resumeWorkspace,savedWorkspace,offlineRequests,moduleCaptureWaitError,ownerPolicy,manifest:JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8')),stages,stageEvents,diagnostics,browserRequests,previewNavigations,previewReadiness,state,terminalDiagnostics,cleanup,failure:String(failure??'')},null,2))
    await info.attach('site-start-counter-diagnostics.json',{path:diagnosticsPath,contentType:'application/json'})
    try{await evidence.flush()}catch(error){if(!failure)throw error}
    if(terminalFailure)throw terminalFailure
  }
})
