import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {captureHMR,attachHMR} from '../fixtures/hmr-events'

const files:Record<string,string>={}
for(const name of ['package.json','package-lock.json'])files['/project/'+name]=readFileSync('fixtures/install-start-wasm/'+name,'utf8')
for(const name of ['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx'])files['/project/'+name]=readFileSync('fixtures/start-basic/'+name,'utf8')
const workspace=process.env.START_WORKSPACE==='1'
const restoreProject=process.env.START_RESTORE==='1'
const cooperative=process.env.COOPERATIVE_KERNEL==='1'
if(workspace){
  const manifest=JSON.parse(files['/project/package.json']),lock=JSON.parse(files['/project/package-lock.json'])
  manifest.workspaces=['packages/*'];manifest.dependencies['@probe/shared']='*'
  lock.packages[''].workspaces=manifest.workspaces
  lock.packages[''].dependencies['@probe/shared']='*'
  lock.packages['packages/shared']={name:'@probe/shared',version:'1.0.0'}
  lock.packages['node_modules/@probe/shared']={resolved:'packages/shared',link:true}
  files['/project/package.json']=JSON.stringify(manifest)
  files['/project/package-lock.json']=JSON.stringify(lock)
  files['/project/packages/shared/package.json']=JSON.stringify({name:'@probe/shared',version:'1.0.0',type:'module',exports:'./index.js'})
  files['/project/packages/shared/index.js']="export const heading='Workspace heading'; export const message='TanStack Start rendered inside the browser runtime.'"
  files['/project/src/routes/index.tsx']="import {heading,message} from '@probe/shared'\n"+files['/project/src/routes/index.tsx']
    .replace("message: 'TanStack Start rendered inside the browser runtime.'",'message')
    .replace('<h1>Bare-bones Start</h1>','<h1>{heading}</h1>')
}
files['/project/server.mjs']=`import {createServer} from 'vite';
const originalError=console.error;console.error=(...args)=>{originalError(...args.map(value=>value?.stack?String(value)+'\\n'+value.stack:value));originalError(new Error('Logged error call site').stack)};
const server=await createServer({server:{host:'127.0.0.1',port:8516,strictPort:true}});await server.listen();console.log('START_READY');`

test(`installed Start runs its plugin, SSR, hydration, server functions and route edits${workspace?' with a linked workspace':''}${restoreProject?' after checkpoint reload':''}${cooperative?' on the cooperative kernel':''}`,async({page,context},info)=>{
  if(process.env.TERMINATION_COOPERATIVE==='1'){
    expect(cooperative,'Termination candidate requires cooperative execution').toBe(true)
    for(const wasm of ['', '-wasm']){
      const name='quickjs-als-asyncify'+wasm+'-o2-generator-queue-yield-profile'+(wasm?'-poll4096':'')+'-cooperative'+(wasm&&process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(wasm&&process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':'')+(wasm&&process.env.COOPERATIVE_UNWIND==='1'?'-unwind':'')+(wasm&&process.env.COOPERATIVE_HEAP_LOOPS==='1'?'-heap-loops':'')
      const metadata=readFileSync('public/'+name+'/build.json')
      expect(JSON.parse(metadata.toString()).interpreterFrames?.limit).toBe(4096)
      await info.attach('start-engine'+wasm+'.json',{body:metadata,contentType:'application/json'})
    }
  }
  const candidate=(process.env.ATOMICS_CANDIDATE==='1'?'-atomics':'')+(process.env.COOPERATIVE_GENERATOR_QUEUE==='1'?'-generator-queue':'')+(process.env.COOPERATIVE_YIELD_PROFILE==='1'?'-yield-profile':'')
  if(cooperative&&candidate){
    for(const wasm of ['', '-wasm']){
      const base='quickjs-als-asyncify'+wasm
      const suffix=candidate+(wasm&&process.env.COOPERATIVE_WASM_POLL==='4096'?'-poll4096':'')
      const metadata=readFileSync('public/'+base+suffix+'-cooperative/build.json')
      expect(JSON.parse(metadata.toString()).interpreterFrames?.limit,'Start candidate must preserve iterative guest calls').toBe(4096)
      await info.attach('start-engine'+wasm+'.json',{body:metadata,contentType:'application/json'})
      await context.route('**/'+base+'-cooperative/**',route=>route.continue({url:route.request().url().replace(base+'-cooperative/',base+suffix+'-cooperative/')}))
    }
  }
  const registryRequestsAfterRestore:string[]=[]
  const diagnostics:string[]=[]
  const hmrEvents:unknown[]=[]
  const stages:string[]=[]
  await page.exposeFunction('startProbeStage',(stage:string)=>stages.push(stage))
  page.on('pageerror',error=>diagnostics.push(error.message))
  page.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text())})
  await page.goto('/sandbox.html')
  try{
    if(restoreProject){
      await page.evaluate(async files=>{
        const {WorkerKernel,checkpoint}=window.sandboxLab
        const kernel=new WorkerKernel(files,{maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
        try{
          await kernel.install({cwd:'/project',ignoreScripts:true})
          await checkpoint('save','installed-start',await kernel.snapshot())
        }finally{kernel.close()}
      },files)
      await page.route('https://registry.npmjs.org/**',route=>{registryRequestsAfterRestore.push(route.request().url());return route.abort()})
      await page.reload()
      stages.push('installed project checkpoint survived lab reload')
    }
    const ssr=await page.evaluate(async({files,restoreProject,cooperative,captureParser,captureCompiler,captureGo,traceHTTP,profileJobs})=>{
      const {WorkerKernel,WorkerHTTP,WorkerWebSocket,URLPreview}=window.sandboxLab
      const kernel=new WorkerKernel(restoreProject?{}:files,{cooperative,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
      const logs:string[]=[];Object.assign(window,{startKernel:kernel,startLogs:logs})
      await (window as any).startProbeStage('install')
      if(restoreProject){
        const snapshot=await window.sandboxLab.checkpoint('load','installed-start')
        if(!snapshot)throw Error('Missing Start checkpoint')
        await kernel.restore(snapshot)
        await (window as any).startProbeStage('restored installed tree without reinstalling')
      }else await kernel.install({cwd:'/project',ignoreScripts:true})
      if(traceHTTP){
        const samples:{at:number;ms:number;error?:string}[]=[]
        let stopped=false,timer:ReturnType<typeof setTimeout>|undefined
        const ping=async()=>{
          if(stopped)return
          const at=performance.now()
          try{await kernel.readText('/project/package.json');samples.push({at,ms:performance.now()-at})}
          catch(error){samples.push({at,ms:performance.now()-at,error:String(error)})}
          if(!stopped&&samples.length<500)timer=setTimeout(ping,250)
        }
        Object.assign(window,{workerPingSamples:samples,stopWorkerPings:()=>{stopped=true;clearTimeout(timer)}})
        void ping()
      }
      if(captureGo){
        const runtimePath='/project/node_modules/esbuild/wasm_exec.js'
        await kernel.writeText(runtimePath,(await kernel.readText(runtimePath))+`\nconst originalResume=Go.prototype._resume;let resumeDepth=0;const resumeTrace=[];Go.prototype._resume=function(){const event={depth:++resumeDepth,time:performance.now(),event:this._pendingEvent?.id,stack:new Error().stack};resumeTrace.push(event);if(resumeTrace.length>32)resumeTrace.shift();try{return originalResume.call(this)}catch(error){event.error=String(error);throw error}finally{event.exited=this.exited;resumeDepth--;if(event.exited||event.error)require('node:fs').writeFileSync('/project/go-resume-trace.json',JSON.stringify(resumeTrace))}};`)
      }
      if(captureCompiler){
        const chunks='/project/node_modules/vite/dist/node/chunks'
        const session=await kernel.openFileSession()
        let names:string[]
        try{names=await session.call('readdir',[chunks]) as string[]}finally{await session.close()}
        for(const name of names){
          if(!name.endsWith('.js'))continue
          const path=chunks+'/'+name,source=await kernel.readText(path)
          const marker='const scannerMissedDeps = crawlDeps.some((dep) => !scanDeps.includes(dep));'
          if(!source.includes(marker))continue
          if(source.split(marker).length!==2)throw Error('Unexpected Vite optimizer trace site')
          await kernel.writeText(path,source.replace(marker,marker+`console.log('OPTIMIZER_CRAWL '+JSON.stringify({at:performance.now(),crawlDeps,scanDeps,needsInteropMismatch,scannerMissedDeps}));`))
        }
        const compilerPath='/project/node_modules/esbuild/lib/main.js'
        const serviceMarker='let sendRequest = (refs, value, callback) => {'
        const original=await kernel.readText(compilerPath)
        if(original.split(serviceMarker).length!==2)throw Error('Unexpected esbuild service timing integration site')
        await kernel.writeText(compilerPath,original.replace(serviceMarker,`const serviceEvents=[];${serviceMarker}
          const event={command:value.command,flags:value.flags,entries:value.entries,start:performance.now()};
          if(serviceEvents.length<512)serviceEvents.push(event);
          const save=()=>require('node:fs').writeFileSync('/project/compiler-service.json',JSON.stringify(serviceEvents));
          save();const originalCallback=callback;callback=(...args)=>{event.end=performance.now();event.error=args[0]?String(args[0]):undefined;save();return originalCallback(...args)};
        `))
        await kernel.writeText(compilerPath,(await kernel.readText(compilerPath))+`\nconst originalTransform=transform;let transformIndex=0;transform=function(input,options){const index=transformIndex++;require('node:fs').writeFileSync('/project/transform-'+index+'.json',JSON.stringify({input,options}));return originalTransform(input,options)};`)
      }
      // Capture the actual failing input before ESM consumers bind the CJS export.
      // This diagnostic wrapper preserves the parser result and rethrows errors.
      if(captureParser){
        const parserPath='/project/node_modules/@babel/parser/lib/index.js'
        await kernel.writeText(parserPath,(await kernel.readText(parserPath))+`\nconst originalParse=exports.parse;exports.parse=function(source,options){try{return originalParse.call(this,source,options)}catch(error){try{require('node:fs').writeFileSync('/project/parser-failure.json',JSON.stringify({source,options,error:String(error)}))}catch{}throw error}};`)
      }
      await (window as any).startProbeStage('spawn')
      const server=await kernel.spawn('node',['server.mjs'],{cwd:'/project',guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:256*1024*1024,timeoutMs:30000,profileJobs})
      let output=''
      await (window as any).startProbeStage('wait for startup')
      for(;;){
        const event=await server.next()
        if(event?.type==='stdout'||event?.type==='stderr'){const text=new TextDecoder().decode(event.bytes);logs.push(text);output+=text}
        if(output.includes('START_READY'))break
        if(!event||event.type==='exit')throw new Error('Start startup failed: '+output)
      }
      void(async()=>{try{for(;;){const event=await server.next();if(event?.type==='stdout'||event?.type==='stderr'){if(logs.length<1000)logs.push(new TextDecoder().decode(event.bytes))}else break}}catch{}})()
      const http=new WorkerHTTP(kernel,8516)
      await (window as any).startProbeStage('SSR request')
      const response=await http.fetch(new Request('http://127.0.0.1:4200/'))
      const result={status:response.status,html:await response.text()}
      Object.assign(window,{startSSR:result})
      if(response.status!==200)throw new Error('Start SSR failed: '+JSON.stringify(result))
      await (window as any).startProbeStage('SSR returned 200, mounting preview')
      const preview=await URLPreview.mount(document.querySelector('#preview')!,{origin:'http://127.0.0.1:4200',server:{fetch:async request=>{
        const started=performance.now()
        logs.push('PREVIEW_REQUEST '+request.url)
        const response=await http.fetch(request)
        logs.push('PREVIEW_RESPONSE '+response.status+' '+request.url)
        if(traceHTTP&&response.body){
          const reader=response.body.getReader();let bytes=0,chunks=0
          const record=(phase:string,error?:unknown)=>logs.push('HTTP_BODY '+JSON.stringify({url:request.url,phase,bytes,chunks,ms:performance.now()-started,error:error===undefined?undefined:String(error)}))
          record('headers')
          return new Response(new ReadableStream({
            async pull(controller){
              try{const next=await reader.read();if(next.done){record('end');reader.releaseLock();controller.close()}else{bytes+=next.value.byteLength;chunks++;if(chunks===1)record('first');controller.enqueue(next.value)}}
              catch(error){record('error',error);reader.releaseLock();controller.error(error)}
            },
            async cancel(reason){record('cancel',reason);try{await reader.cancel(reason)}finally{reader.releaseLock()}},
          }),{status:response.status,statusText:response.statusText,headers:response.headers})
        }
        return response
      }},connectWebSocket:(url,protocols)=>WorkerWebSocket.connect(kernel,8516,'http://127.0.0.1:4200',url,protocols)})
      Object.assign(window,{startPreview:preview})
      await (window as any).startProbeStage('preview mounted')
      return result
    },{files,restoreProject,cooperative,captureParser:process.env.START_CAPTURE_PARSER==='1',captureCompiler:process.env.START_CAPTURE_COMPILER==='1',captureGo:process.env.START_CAPTURE_GO==='1',traceHTTP:process.env.START_TRACE_HTTP==='1',profileJobs:process.env.START_PROFILE_JOBS==='1'})
    await info.attach('ssr.html',{body:ssr.html,contentType:'text/html'})
    expect(ssr.html).toContain(workspace?'Workspace heading':'Bare-bones Start')
    expect(ssr.html).toContain('TanStack Start rendered inside the browser runtime.')
    const preview=page.frameLocator('#preview iframe')
    if(process.env.START_DIAGNOSTIC_RELOAD==='1'){
      // Preserve the cold-start failure. Reload only to expose later failures,
      // never as the acceptance path or a runtime recovery policy.
      await expect.soft(preview.locator('main[data-hydrated="true"]'),'cold Start hydration before diagnostic reload').toBeVisible({timeout:60000})
      stages.push('diagnostic reload after cold hydration observation')
      await preview.locator('html').evaluate(()=>location.reload())
      await expect(preview.locator('main[data-hydrated="true"]')).toBeVisible({timeout:60000})
    }else await expect(preview.locator('main[data-hydrated="true"]')).toBeVisible({timeout:60000})
    stages.push('hydration effect committed')
    await expect(preview.locator('#start-count')).toHaveText('Count: 0')
    await preview.locator('#start-count').click({timeout:10000})
    await expect(preview.locator('#start-count')).toHaveText('Count: 1')
    stages.push('client counter updated')
    await preview.locator('#server-call').click()
    await expect(preview.locator('#server-reply')).toContainText('"method":"POST"')
    stages.push('POST server function completed')
    if(workspace){
      await captureHMR(page.frames().find(frame=>frame.url()==='http://127.0.0.1:4200/')!,hmrEvents)
      await expect(preview.locator('h1')).toHaveText('Workspace heading')
      await page.evaluate(async()=>{
        await (window as any).startKernel.writeText('/project/packages/shared/index.js',"export const heading='Edited workspace'; export const message='Updated server workspace message'")
      })
      await expect(preview.locator('h1')).toHaveText('Edited workspace',{timeout:30000})
      await expect(preview.locator('#start-count')).toHaveText('Count: 1')
      const updated=await page.evaluate(async()=>{
        const http=new window.sandboxLab.WorkerHTTP((window as any).startKernel,8516)
        const response=await http.fetch(new Request('http://127.0.0.1:4200/'))
        return {status:response.status,html:await response.text()}
      })
      expect(updated.status).toBe(200)
      expect(updated.html).toContain('Updated server workspace message')
      expect(updated.html).toContain('Edited workspace')
      stages.push('linked workspace edit reached HMR and SSR')
      await page.evaluate(async()=>{
        await (window as any).startKernel.writeText('/project/packages/shared/index.js','export const heading = ;')
      })
      await expect(preview.getByText('Parse failure: Expression expected',{exact:false})).toBeVisible({timeout:30000})
      await info.attach('broken-workspace-preview.txt',{body:await preview.locator('body').innerText(),contentType:'text/plain'})
      await attachHMR(page.frames().find(frame=>frame.url()==='http://127.0.0.1:4200/')!)
      stages.push('shared syntax error presentation checked')
      await page.evaluate(async()=>{
        await (window as any).startKernel.writeText('/project/packages/shared/index.js',"export const heading='Repaired workspace'; export const message='Repaired server workspace message'")
      })
      const repaired=await page.evaluate(async()=>{
        const http=new window.sandboxLab.WorkerHTTP((window as any).startKernel,8516)
        const response=await http.fetch(new Request('http://127.0.0.1:4200/'))
        return {status:response.status,html:await response.text()}
      })
      await info.attach('repaired-workspace-ssr.json',{body:JSON.stringify(repaired),contentType:'application/json'})
      expect(repaired.status).toBe(200)
      expect(repaired.html).toContain('Repaired server workspace message')
      stages.push('shared syntax error repaired on server')
      await expect.soft(preview.locator('h1')).toHaveText('Repaired workspace',{timeout:30000})
      const errorFrame=page.frames().find(frame=>frame.url()==='http://127.0.0.1:4200/')!
      const routerState=await errorFrame.evaluate(()=>{
        const router=(window as any).__TSR_ROUTER__
        return router?.state.matches.map((match:any)=>({id:match.id,status:match.status,error:String(match.error),loaderData:match.loaderData}))
      })
      await info.attach('repaired-router-state.json',{body:JSON.stringify(routerState??null),contentType:'application/json'})
      // Diagnostic only: keep the automatic recovery assertion failing above.
      // Determine whether re-running the route loader clears the stale error.
      await errorFrame.evaluate(async()=>{await (window as any).__TSR_ROUTER__.invalidate()})
      await expect(preview.locator('h1')).toHaveText('Repaired workspace',{timeout:30000})
      stages.push('diagnostic router invalidation restored repaired page')
      await expect(preview.locator('vite-error-overlay')).toHaveCount(0)
      stages.push('shared syntax error repaired without restarting server')
    }
    await preview.locator('#about-link').click()
    await expect(preview.locator('#about-title')).toHaveText('Second route')
    await page.evaluate(async()=>{
      const kernel=(window as any).startKernel,path='/project/src/routes/about.tsx'
      await kernel.writeText(path,(await kernel.readText(path)).replace('Second route','Edited route'))
    })
    await expect(preview.locator('#about-title')).toHaveText('Edited route')
    stages.push('navigation and route-edit HMR completed')
    await info.attach('start-preview.png',{body:await page.screenshot(),contentType:'image/png'})
    expect(registryRequestsAfterRestore).toEqual([])
  }finally{
    await info.attach('runtime-interrupts.json',{body:JSON.stringify(await page.evaluate(()=>(window as any).startKernel?.jobProfile.filter((event:any)=>event.phase==='interrupt')??[]).catch(()=>[])),contentType:'application/json'})
    if(workspace)await info.attach('hmr-events.json',{body:JSON.stringify(hmrEvents),contentType:'application/json'})
    if(process.env.START_PROFILE_JOBS==='1')await info.attach('job-profile.json',{body:JSON.stringify(await page.evaluate(()=>(window as any).startKernel?.jobProfile??[]).catch(()=>[])),contentType:'application/json'})
    if(process.env.START_TRACE_HTTP==='1'){
      const samples=await page.evaluate(()=>{(window as any).stopWorkerPings?.();return (window as any).workerPingSamples??[]}).catch(()=>[])
      await info.attach('worker-pings.json',{body:JSON.stringify(samples),contentType:'application/json'})
    }
    if(process.env.START_CAPTURE_GO==='1'){
      const trace=await page.evaluate(()=>(window as any).startKernel?.readText('/project/go-resume-trace.json').catch(()=>undefined)).catch(()=>undefined)
      if(trace)await info.attach('go-resume-trace.json',{body:trace,contentType:'application/json'})
    }
    if(process.env.START_CAPTURE_COMPILER==='1'){
      const service=await page.evaluate(()=>(window as any).startKernel?.readText('/project/compiler-service.json').catch(()=>undefined)).catch(()=>undefined)
      if(service)await info.attach('compiler-service.json',{body:service,contentType:'application/json'})
      const captures=await page.evaluate(async()=>{
        const kernel=(window as any).startKernel,results=[]
        for(let index=0;index<200;index++){
          const capture=await kernel?.readText('/project/transform-'+index+'.json').catch(()=>undefined)
          if(capture===undefined)break
          results.push(JSON.parse(capture))
        }
        return results
      }).catch(()=>[])
      await info.attach('compiler-transforms.json',{body:JSON.stringify(captures),contentType:'application/json'})
    }
    const ssrResult=await page.evaluate(()=>(window as any).startSSR).catch(()=>undefined)
    if(ssrResult)await info.attach('ssr-result.json',{body:JSON.stringify(ssrResult),contentType:'application/json'})
    const parserFailure=await page.evaluate(()=>(window as any).startKernel?.readText('/project/parser-failure.json').catch(()=>undefined)).catch(()=>undefined)
    if(parserFailure)await info.attach('parser-failure.json',{body:parserFailure,contentType:'application/json'})
    await info.attach('start-stages.json',{body:JSON.stringify(stages),contentType:'application/json'})
    await info.attach('start-server.json',{body:JSON.stringify(await page.evaluate(()=>(window as any).startLogs??[]).catch(error=>['Logs unavailable: '+String(error)])),contentType:'application/json'})
    await info.attach('start-browser.json',{body:JSON.stringify(diagnostics),contentType:'application/json'})
    await page.evaluate(()=>{(window as any).startPreview?.close();(window as any).startKernel?.close()}).catch(()=>{})
    if(restoreProject)await page.evaluate(()=>window.sandboxLab.checkpoint('delete','installed-start')).catch(()=>{})
  }
})
