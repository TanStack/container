import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const hosting=JSON.parse(readFileSync(resolve(root,'preview-host/hosting.json'),'utf8'))
if(process.env.VITE_WORKER_MIB!==undefined&&!['64','128'].includes(process.env.VITE_WORKER_MIB))throw Error('VITE_WORKER_MIB diagnostic supports only 64 or 128')
const asyncWorkers=process.env.VITE_ASYNC_WORKERS
if(asyncWorkers!==undefined&&!['1','2','4'].includes(asyncWorkers))throw Error('VITE_ASYNC_WORKERS supports only 1, 2 or 4')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,...(process.env.VITE_WORKER_MIB?{workerMaxBytes:Number(process.env.VITE_WORKER_MIB)*1024*1024}:{}),timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let owner,previewHost,ownerURL,previewOrigin,snapshot
async function listen(server){await new Promise(done=>server.listen(0,'127.0.0.1',done));return `http://127.0.0.1:${server.address().port}`}
test.beforeAll(async()=>{
  snapshot=JSON.stringify(await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['vite','@rolldown/binding-wasm32-wasi']))
  owner=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<div id="preview"></div><script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk;</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  previewHost=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    const route=hosting.routes.find(route=>route.path===path&&route.method===req.method)
    if(!route){res.writeHead(hosting.fallbackStatus,{'content-type':'text/plain'});res.end('No workspace attached');return}
    let content=readFileSync(resolve(root,'preview-host',route.file))
    if(process.env.VITE_NETWORK_TIMING==='1'&&path==='/__sandbox/sw.js'){
      // Test-only scalar trace. Keep routing, checks and response handling intact.
      content='self.previewRouteTrace=[];const traceRoute=(phase,url)=>{if(self.previewRouteTrace.length<96)self.previewRouteTrace.push({phase,url,time:Date.now()})};\n'+content.toString()
      content+='\nself.addEventListener("message",event=>{if(event.data?.type==="test-read-route-trace"&&event.ports[0])event.ports[0].postMessage(self.previewRouteTrace)});'
      content=content.replace('const request = event.request','const request = event.request;traceRoute("start",request.url)')
        .replace('const sourceOrigin = source ?', 'traceRoute("client-resolved",request.url);const sourceOrigin = source ?')
        .replace('const bridges = clients.filter(', 'traceRoute("clients-listed",request.url);const bridges = clients.filter(')
        .replace('if (result.error) throw', 'traceRoute("response-received",request.url);if (result.error) throw')
    }
    res.writeHead(200,route.headers);res.end(content)
  })
  ownerURL=await listen(owner);previewOrigin=await listen(previewHost)
})
test.afterAll(async()=>{for(const server of [owner,previewHost])if(server)await new Promise(done=>server.close(done))})

test('Vite8 browser client applies HMR in isolated preview without resetting state',async({page},info)=>{
  const traceWorkers=process.env.VITE_TRACE_WORKERS==='1'
  const passiveDiagnostics=process.env.VITE_DIAGNOSTICS==='1'
  const traceHooks=process.env.VITE_TRACE_HOOKS==='1'
  const observeRender=process.env.VITE_OBSERVE_RENDER==='1'
  let renderObservation
  let workflowError
  const networkTiming=process.env.VITE_NETWORK_TIMING==='1',networkEvents=[],networkStarted=performance.now()
  if(networkTiming){
    const record=(phase,request,extra={})=>{
      if(networkEvents.length>=96||!request.url().startsWith(previewOrigin+'/'))return
      networkEvents.push({phase,elapsedMs:performance.now()-networkStarted,url:request.url().slice(0,512),type:request.resourceType(),...extra})
    }
    page.on('request',request=>record('request',request))
    page.on('response',response=>record('response',response.request(),{status:response.status()}))
    page.on('requestfinished',request=>record('finished',request))
    page.on('requestfailed',request=>record('failed',request,{error:request.failure()?.errorText?.slice(0,200)}))
  }
  const consoleMessages=[]
  page.on('console',message=>consoleMessages.push({type:message.type(),text:message.text()}))
  page.on('pageerror',error=>consoleMessages.push({type:'pageerror',text:error.message}))
  await page.goto(ownerURL);await page.waitForFunction(()=>!!window.sdk)
  try{
    await page.evaluate(async({policy,previewOrigin,traceWorkers,passiveDiagnostics,traceHooks,networkTiming,asyncWorkers})=>{
      const closure=await fetch('/fixture.json').then(r=>r.json())
      const files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
      files['/project/app/index.html']='<html><head><title>Vite preview fixture</title></head><body><button id="count"></button><p id="message"></p><script type="module" src="/main.ts"></script></body></html>'
      files['/project/app/message.ts']='export const message: string = "first version";'
      files['/project/app/main.ts']=`import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);`
      files['/project/server.mjs']=`import {createServer} from 'vite';const server=await createServer({root:'/project/app',configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:8524,strictPort:true}});await server.listen();console.log('VITE_READY');`
      if(traceHooks)files['/project/server.mjs']=files['/project/server.mjs'].replace('await server.listen();',`
        let hookCalls=0,hookEvents=0;const hookStarted=performance.now();
        // Elapsed wall time includes async waits and overlapping work, not CPU time.
        const emitHook=row=>{if(hookEvents++<96)console.log('VITE_HOOK '+JSON.stringify({...row,atMs:performance.now()-hookStarted}))};
        for(const plugin of server.config.plugins)for(const name of ['load','transform']){
          const original=plugin[name],handler=typeof original==='function'?original:original?.handler;
          if(typeof handler!=='function')continue;
          const wrapped=function(...args){
            const call=++hookCalls,row={call,plugin:String(plugin.name).slice(0,80),hook:name,id:String(args[name==='transform'?1:0]).slice(0,120)};
            emitHook({...row,phase:'begin'});
            try{
              const result=handler.apply(this,args);
              if(result&&typeof result.then==='function')result.then(()=>emitHook({...row,phase:'end'}),error=>emitHook({...row,phase:'error',message:String(error).slice(0,160)}));
              else emitHook({...row,phase:'end'});
              return result;
            }catch(error){emitHook({...row,phase:'error',message:String(error).slice(0,160)});throw error}
          };
          plugin[name]=typeof original==='function'?wrapped:{...original,handler:wrapped};
        }
        await server.listen();
      `)
      if(traceWorkers)files['/project/server.mjs']=files['/project/server.mjs'].replace("import {createServer} from 'vite';",`
        const workerModule=(await import('node:worker_threads')).default,OriginalWorker=workerModule.Worker;
        let creations=0,protocolEvents=0;const began=Date.now();
        const record=(type,row)=>console.log('VITE_WORKER_TRACE '+JSON.stringify({type,atMs:Date.now()-began,...row}));
        const protocol=(creation,direction,message)=>{const value=message?.__emnapi__;if(!value||!['load','loaded','start','cleanup-thread','spawn-thread','async-send'].includes(value.type)||protocolEvents>=96)return;protocolEvents++;const tid=value.payload?.tid;record('protocol',{creation,direction,protocol:value.type,...(Number.isInteger(tid)?{tid}:{})})};
        workerModule.Worker=class extends OriginalWorker{
          constructor(...args){const creation=++creations;if(creation<=16)record('create',{creation,file:String(args[0]),stack:new Error('worker creation').stack?.slice(0,1600)});super(...args);this.traceCreation=creation;this.on('message',message=>protocol(creation,'receive',message));if(creation<=16)this.once('exit',code=>record('exit',{creation,code}))}
          postMessage(message,...args){protocol(this.traceCreation,'send',message);return super.postMessage(message,...args)}
        };
        const moduleAPI=await import('node:module');moduleAPI.syncBuiltinESMExports?.();
        const {createServer}=await import('vite');
      `)
      const kernel=new window.sdk.WorkerKernel(files,policy)
      const state=window.vitePreview={kernel,output:'',cleanup:[],deadline:false,startedAt:performance.now()}
      state.timer=setTimeout(()=>{state.deadline=true;kernel.close(new Error('Preview workflow deadline'))},15000)
      state.child=await kernel.spawn('node',['/project/server.mjs'],{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs',...(asyncWorkers?{NAPI_RS_ASYNC_WORK_POOL_SIZE:asyncWorkers}:{})},lifetime:'session',guestWasm:true,webAPIs:true,diagnostics:passiveDiagnostics,maxBytes:policy.maxBytes,timeoutMs:15000})
      for(;;){const event=await state.child.next();if(event?.type==='stdout'||event?.type==='stderr')state.output+=new TextDecoder().decode(event.bytes);if(state.output.includes('VITE_READY'))break;if(!event||event.type==='exit')throw Error('Vite did not start: '+state.output)}
      state.processResult=state.child.wait().then(result=>{state.result={...result,stdout:result.stdout?.slice(0,32768),stderr:result.stderr?.slice(0,32768)}},error=>{state.resultError=String(error)})
      state.outputEvents=[]
      state.outputDrain=(async()=>{
        for(;;){
          const event=await state.child.next();if(!event)break
          if(event.type==='stdout'||event.type==='stderr'){
            const text=new TextDecoder().decode(event.bytes)
            if(state.outputEvents.length<100)state.outputEvents.push({type:event.type,text:text.slice(0,Math.max(0,32768-state.output.length))})
            if(state.output.length<32768)state.output+=text.slice(0,32768-state.output.length)
          }
          if(event.type==='exit'){state.exit=event;break}
        }
      })().catch(error=>{state.outputDrainError=String(error)})
      state.httpTrace=[]
      const trace=(phase,details={})=>{if(networkTiming&&state.httpTrace.length<96)state.httpTrace.push({phase,atMs:performance.now()-state.startedAt,...details})}
      let connections=0
      const transport=networkTiming?{async connect(port){
        const connection=++connections;trace('connect-start',{connection})
        const socket=await kernel.connect(port);trace('connected',{connection})
        return {
          async write(bytes){trace('write-start',{connection,bytes:bytes.length});const result=await socket.write(bytes);trace('write-done',{connection});return result},
          async read(){trace('read-start',{connection});const result=await socket.read();trace('read-done',{connection,type:result?.type,bytes:result?.bytes?.length});return result},
          async close(){trace('close-start',{connection});const result=await socket.close();trace('close-done',{connection});return result},
        }
      }}:kernel
      const http=new window.sdk.WorkerHTTP(transport,8524)
      const server=networkTiming?{async fetch(request){const path=new URL(request.url).pathname;trace('fetch-start',{path});try{const response=await http.fetch(request);trace('headers',{path,status:response.status});return response}catch(error){trace('fetch-error',{path,error:String(error).slice(0,200)});throw error}}}:http
      state.preview=await window.sdk.URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server,connectWebSocket:(url,protocols)=>window.sdk.WorkerWebSocket.connect(kernel,8524,previewOrigin,url,protocols)})
    },{policy,previewOrigin,traceWorkers,passiveDiagnostics,traceHooks,networkTiming,asyncWorkers})
    const frame=page.frameLocator('#preview iframe')
    await expect(frame.locator('#message')).toHaveText('first version')
    await expect(frame.locator('#count')).toHaveText('42')
    await frame.locator('#count').click()
    await expect(frame.locator('#count')).toHaveText('43')
    await expect.poll(()=>consoleMessages.some(message=>message.text.includes('[vite] connected.'))).toBe(true)
    const marker=await frame.locator('body').evaluate(()=>{window.__hmrDocumentMarker='same-document';return window.__hmrDocumentMarker})
    await page.evaluate(()=>window.vitePreview.kernel.writeText('/project/app/message.ts','export const message: string = "second version";'))
    await expect(frame.locator('#message')).toHaveText('second version')
    await expect(frame.locator('#count')).toHaveText('43')
    expect(await frame.locator('body').evaluate(()=>window.__hmrDocumentMarker)).toBe(marker)
    expect(await page.evaluate(()=>window.vitePreview.deadline)).toBe(false)
    const screenshotPath=info.outputPath('rendered-hmr.png')
    await page.screenshot({path:screenshotPath})
    await info.attach('rendered-hmr.png',{path:screenshotPath,contentType:'image/png'})
  }catch(error){
    workflowError=String(error)
    if(observeRender&&await page.evaluate(()=>Boolean(window.vitePreview))){
      // Keep the original assertion failure. Observe only within the existing
      // workflow deadline, without extending the runtime or calling this a pass.
      const remaining=await page.evaluate(()=>Math.max(1,15000-(performance.now()-window.vitePreview.startedAt)))
      try{
        await expect(page.frameLocator('#preview iframe').locator('#message')).toHaveText('first version',{timeout:remaining})
        renderObservation={rendered:true}
      }catch(cause){renderObservation={rendered:false,message:String(cause).slice(0,500)}}
      renderObservation.elapsedMs=await page.evaluate(()=>performance.now()-window.vitePreview.startedAt)
    }
    throw error
  }finally{
    const serviceWorkerTrace=networkTiming?await Promise.all(page.frames().filter(frame=>frame.url()===previewOrigin+'/__sandbox/bridge.html').map(async frame=>({url:frame.url(),events:await frame.evaluate(()=>new Promise(resolve=>{
      const channel=new MessageChannel()
      const timer=setTimeout(()=>{channel.port1.close();resolve([{error:'Trace response timed out'}])},500)
      channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data)}
      navigator.serviceWorker.controller.postMessage({type:'test-read-route-trace'},[channel.port2])
    })).catch(error=>[{error:String(error)}])}))):undefined
    const evidence=await page.evaluate(async()=>{
      const state=window.vitePreview;if(!state)return {missingState:true}
      clearTimeout(state.timer)
      const completedBeforeCleanup=Boolean(state.result||state.resultError)
      const jobProfileBeforeCleanup=state.kernel.jobProfile.slice(0,100)
      const diagnostics=state.preview?.diagnostics,requests=state.preview?.requests
      try{state.preview?.close()}catch(error){state.cleanup.push(String(error))}
      try{await state.child?.dispose()}catch(error){state.cleanup.push(String(error))}
      await Promise.all([state.outputDrain,state.processResult])
      const jobProfileAfterDispose=state.kernel.jobProfile.slice(0,100)
      const workerLifecycle=state.kernel.workerLifecycle.slice(-256)
      try{state.kernel.close()}catch(error){state.cleanup.push(String(error))}
      return {elapsedMs:performance.now()-state.startedAt,httpTrace:state.httpTrace,output:state.output,outputEvents:state.outputEvents,result:state.result,resultError:state.resultError,outputDrainError:state.outputDrainError,exit:state.exit,completedBeforeCleanup,jobProfileBeforeCleanup,jobProfileAfterDispose,workerLifecycle,deadline:state.deadline,cleanup:state.cleanup,diagnostics,requests}
    })
    const evidencePath=info.outputPath('rendered-hmr.json')
    await writeFile(evidencePath,JSON.stringify({sdk:root,policy,effectiveWorkerMiB:(policy.workerMaxBytes??policy.maxBytes)/1024/1024,asyncWorkers:asyncWorkers??'binding default',traceWorkers,passiveDiagnostics,traceHooks,observeRender,renderObservation,networkTiming,networkEvents,serviceWorkerTrace,workflowError,scope:'Actual browser Vite client, local module HMR, no third-party dependency prebundle assertion',consoleMessages,evidence},null,2))
    await info.attach('rendered-hmr.json',{path:evidencePath,contentType:'application/json'})
    // Preserve the original workflow failure, with cleanup errors in evidence.
    // Cleanup must still succeed for an otherwise successful workflow to pass.
    if(!workflowError)expect(evidence.cleanup??[]).toEqual([])
  }
})
