import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT),fixture=resolve('fixtures/start-vite8-wasm')
const manifest=JSON.parse(readFileSync(resolve(fixture,'package.json'),'utf8'))
const traceHooks=process.env.START_TRACE_HOOKS==='1'
const profileJobs=process.env.START_PROFILE_JOBS==='1'
const diagnostics=profileJobs||process.env.START_DIAGNOSTICS==='1'
const traceWorkers=process.env.START_TRACE_WORKERS==='1'
const traceRuntime=process.env.START_TRACE_RUNTIME==='1'
const tracePool=process.env.START_TRACE_POOL==='1'
const traceImmediates=process.env.START_TRACE_IMMEDIATES==='1'
const resolveProbe=process.env.START_RESOLVE_PROBE==='1'
const asyncWorkers=process.env.START_ASYNC_WORKERS
if(asyncWorkers!==undefined&&!/^[1-4]$/.test(asyncWorkers))throw Error('START_ASYNC_WORKERS must be 1 through 4')
const workerMiB=Number(process.env.START_WORKER_MIB??64)
if(![32,48,64].includes(workerMiB))throw Error('START_WORKER_MIB must be 32, 48 or 64')
const profiler=traceHooks?readFileSync('tests/fixtures/vite-hook-profiler.mjs','utf8'):''
const workerProtocol=traceWorkers?readFileSync('tests/fixtures/worker-protocol-trace.mjs','utf8'):''
const app=Object.fromEntries(['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx'].map(path=>['/project/app/'+path,readFileSync('fixtures/start-basic/'+path,'utf8')]))
// The 86,209,566-byte installed closure needs the existing Start workspace profile,
// rather than the smaller Vite-only 64 MiB profile. Execution limits are unchanged.
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:workerMiB*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:128*1024*1024}}
let owner,url,snapshot,preparation,closureBytes
test.beforeAll(async()=>{
 const closure=await collectInstalledClosure(fixture,Object.keys(manifest.dependencies))
 closureBytes=Object.values(closure.files).reduce((sum,file)=>sum+Buffer.from(file.base64,'base64').length,0)
 preparation=closure.preparation;snapshot=JSON.stringify(closure)
 owner=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
  if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
  try{if(!path.startsWith('/sdk/'))throw Error();const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice(5))));if(!file.startsWith(sdkRoot+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
 });await new Promise(done=>owner.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${owner.address().port}`
})
test.afterAll(async()=>{if(owner)await new Promise(done=>owner.close(done))})

test('packaged Start on Vite8 loads unchanged config and server-renders two routes',async({page},info)=>{
 test.setTimeout(60000)
 await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
 const observed=await page.evaluate(async({app,policy,profiler,profileJobs,diagnostics,traceWorkers,traceRuntime,tracePool,traceImmediates,resolveProbe,asyncWorkers,workerProtocol})=>{
  const started=performance.now(),elapsed=()=>Math.round(performance.now()-started)
  const evidence={stages:[],output:'',outputEvents:[],hookEvents:[],runtimeEvents:[],immediates:[],poolEvents:[],poolAllocations:[],resources:[],responses:[],cleanupErrors:[],deadlineExceeded:false};let kernel,child,timer,drain
  const stage=phase=>evidence.stages.push({phase,elapsedMs:elapsed()})
  const sample=async phase=>{if(kernel)try{evidence.resources.push({phase,elapsedMs:elapsed(),value:await kernel.resources()})}catch(error){evidence.resources.push({phase,elapsedMs:elapsed(),error:error.message})}}
  try{
   const closure=await fetch('/fixture.json').then(response=>response.json())
   const files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
   Object.assign(files,app,{'/project/package.json':'{"type":"module"}','/project/server.mjs':`import {createServer} from 'vite';console.log('START_IMPORTED');const server=await createServer({root:'/project/app',logLevel:'silent',server:{host:'127.0.0.1',port:8531,strictPort:true}});console.log('START_CREATED');await server.listen();console.log('START_READY')`})
   if(resolveProbe)files['/project/server.mjs']+=`;const probeId='@tanstack/react-start-server';for(const [index,entry] of server.config.resolve.alias.slice(0,64).entries()){console.log('START_ALIAS_BEGIN '+JSON.stringify({index,find:String(entry.find)}));const matched=entry.find instanceof RegExp?entry.find.test(probeId):probeId===entry.find||probeId.startsWith(entry.find+'/');console.log('START_ALIAS_END '+JSON.stringify({index,matched}))}console.log('START_RESOLVE_BEGIN');console.log('START_RESOLVE_END '+JSON.stringify(await server.environments.ssr.pluginContainer.resolveId(probeId,'/project/node_modules/@tanstack/react-start/dist/esm/server.js',{ssr:true})));`
   if(profiler){files['/project/profiler.mjs']=profiler;files['/project/server.mjs']="import {hookProfiler} from './profiler.mjs';"+files['/project/server.mjs'].replace("root:'/project/app',","root:'/project/app',plugins:[hookProfiler()],")}
   if(traceWorkers)files['/project/server.mjs']=files['/project/server.mjs'].replace("import {createServer} from 'vite';",`import {Worker} from 'node:worker_threads';let tracedTerminations=0,tracedPostErrors=0;const originalPostMessage=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){try{return originalPostMessage.apply(this,args)}catch(error){if(tracedPostErrors++<16)console.log('START_WORKER_POST_ERROR '+JSON.stringify({pid:process.pid,threadId:this.threadId,name:error.name,message:error.message,stack:error.stack}));throw error}};const originalTerminate=Worker.prototype.terminate;Worker.prototype.terminate=function(...args){if(tracedTerminations++<16)console.log('START_WORKER_TERMINATE '+JSON.stringify({pid:process.pid,threadId:this.threadId,stack:new Error('termination caller').stack}));return originalTerminate.apply(this,args)};process.on('exit',code=>console.log('START_PROCESS_EXIT '+JSON.stringify({pid:process.pid,code})));const {createServer}=await import('vite');`)
   if(traceWorkers)files['/project/server.mjs']=files['/project/server.mjs'].replace("const {createServer}=await import('vite');",`const workerModule=(await import('node:worker_threads')).default;let workerCreations=0;workerModule.Worker=class extends Worker{constructor(...args){const creation=++workerCreations;if(creation<=16)console.log('START_WORKER_CREATE '+JSON.stringify({creation,file:String(args[0]),asyncWorkers:args[1]?.env?.NAPI_RS_ASYNC_WORK_POOL_SIZE,stack:new Error('worker creation').stack}));super(...args);if(creation<=16)this.once('exit',code=>console.log('START_WORKER_EXIT '+JSON.stringify({creation,code})))}};const {createServer}=await import('vite');`)
   if(traceWorkers)files['/project/server.mjs']=files['/project/server.mjs'].replace('super(...args);if(creation<=16)',`super(...args);if(creation<=16)this.once('error',error=>console.log('START_WORKER_ERROR '+JSON.stringify({creation,name:error.name,code:error.code,message:error.message})));if(creation<=16)`)
   if(workerProtocol){files['/project/worker-protocol.mjs']=workerProtocol;files['/project/server.mjs']=files['/project/server.mjs'].replace("const {createServer}=await import('vite');",`const {traceWorkerProtocol}=await import('./worker-protocol.mjs');traceWorkerProtocol(workerModule,row=>console.log('START_WORKER_PROTOCOL '+JSON.stringify(row)),96,['load','loaded','start','spawn-thread','cleanup-thread']);const {createServer}=await import('vite');`)}
   if(traceRuntime)files['/project/server.mjs']=files['/project/server.mjs'].replace("console.log('START_IMPORTED');",`const {t:runtimeBindingGetter}=await import('/project/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs');const runtimeBinding=runtimeBindingGetter();let runtimeSequence=0,runtimeCalls=0;const runtimeRecord=row=>{const sequence=++runtimeSequence;if(sequence<=64)console.log('START_RUNTIME '+JSON.stringify({sequence,ms:performance.now(),...row}))};for(const method of ['startAsyncRuntime','shutdownAsyncRuntime']){const original=runtimeBinding[method];if(typeof original!=='function')throw Error('Missing runtime method '+method);runtimeBinding[method]=function(...args){const call=++runtimeCalls;runtimeRecord({call,method,phase:'enter',caller:String(new Error('runtime caller').stack).slice(0,1600)});try{const result=Reflect.apply(original,this,args);runtimeRecord({call,method,phase:'return'});return result}catch(error){runtimeRecord({call,method,phase:'throw',message:String(error.message).slice(0,800)});throw error}}}console.log('START_IMPORTED');`)
   if(tracePool){
    const poolSetup=`const {ThreadManager:StartPoolManager}=await import('@emnapi/wasi-threads');const startPoolState={stage:'importing',runtime:null};const startPoolIds=new WeakMap();let startPoolId=0,startPoolEvents=0,startPoolAllocations=0;const startPoolTotals={get:0,returns:0,allocations:0,throws:0};const startPoolIdentity=worker=>{if(!worker)return undefined;if(!startPoolIds.has(worker))startPoolIds.set(worker,++startPoolId);return startPoolIds.get(worker)};const startPoolSnapshot=pool=>({idle:pool.unusedWorkers.length,active:Object.keys(pool.pthreads).length,workers:pool.unusedWorkers.slice(0,12).map(startPoolIdentity),tids:Object.keys(pool.pthreads).slice(0,12)});const startPoolRecord=row=>{if(row.allocation&&++startPoolAllocations<=16)console.log('START_POOL_ALLOCATION '+JSON.stringify({recentImmediates:typeof startImmediateRecent==='undefined'?[]:startImmediateRecent.slice(-48).map(({tail,caller,...event})=>({...event,caller:caller?.split('\\n')[0].slice(-160)})),ms:performance.now(),stage:startPoolState.stage,runtime:startPoolState.runtime,totals:{...startPoolTotals},...row}));const {callerHead,callerTail,...detail}=row;const sequence=++startPoolEvents;if(sequence<=96)console.log('START_POOL '+JSON.stringify({sequence,ms:performance.now(),stage:startPoolState.stage,runtime:startPoolState.runtime,totals:{...startPoolTotals},...(sequence===96?{truncated:true}:detail)}))};for(const method of ['getNewWorker','returnWorkerToPool']){const original=StartPoolManager.prototype[method];if(typeof original!=='function')throw Error('Missing pool method '+method);StartPoolManager.prototype[method]=function(...args){const allocation=method==='getNewWorker'&&this.unusedWorkers.length===0;startPoolTotals[method==='getNewWorker'?'get':'returns']++;if(allocation)startPoolTotals.allocations++;const allocationCaller=allocation?String(new Error('pool allocation caller').stack).split('\\n'):undefined;const before=startPoolSnapshot(this);try{const result=Reflect.apply(original,this,args);startPoolRecord({method,phase:'return',allocation,worker:startPoolIdentity(method==='getNewWorker'?result:args[0]),...(allocationCaller?{callerHead:allocationCaller.slice(0,8),callerTail:allocationCaller.slice(-10)}:{}),before,after:startPoolSnapshot(this)});return result}catch(error){startPoolTotals.throws++;startPoolRecord({method,phase:'throw',allocation,...(allocationCaller?{callerHead:allocationCaller.slice(0,8),callerTail:allocationCaller.slice(-10)}:{}),before,after:startPoolSnapshot(this),message:String(error.message).slice(0,400)});throw error}}}`
    files['/project/server.mjs']=files['/project/server.mjs'].replace("import {createServer} from 'vite';","const {createServer}=await import('vite');").replace("const {createServer}=await import('vite');",poolSetup+"const {createServer}=await import('vite');")
    for(const name of ['IMPORTED','CREATED','READY'])files['/project/server.mjs']=files['/project/server.mjs'].replace("console.log('START_"+name+"')","startPoolState.stage='"+name+"';console.log('START_"+name+"')")
    if(traceRuntime)files['/project/server.mjs']=files['/project/server.mjs'].replace('const runtimeRecord=row=>{','const runtimeRecord=row=>{startPoolState.runtime={call:row.call,method:row.method,phase:row.phase};')
   }
   if(traceImmediates){
    const setup=`const startImmediateRecent=[];let currentImmediate=0;const originalImmediate=globalThis.setImmediate;let nextImmediate=0,immediateTotal=0;const immediateLog=row=>{const sequence=++immediateTotal;startImmediateRecent.push({sequence,ms:performance.now(),...row});if(startImmediateRecent.length>64)startImmediateRecent.shift();if(sequence<=1024)console.log('START_IMMEDIATE '+JSON.stringify({sequence,ms:performance.now(),...(sequence===1024?{truncated:true}:row)}))};globalThis.setImmediate=function(callback,...args){if(typeof callback!=='function')return Reflect.apply(originalImmediate,this,[callback,...args]);const id=++nextImmediate,parent=currentImmediate,stack=String(new Error().stack).split('\\n');immediateLog({phase:'queued',id,parent,caller:stack.slice(1,4).join('\\n').slice(0,600),tail:stack.slice(-3).join('\\n').slice(0,400)});return Reflect.apply(originalImmediate,this,[function(...values){const previous=currentImmediate;currentImmediate=id;immediateLog({phase:'begin',id,parent});try{return Reflect.apply(callback,this,values)}finally{immediateLog({phase:'end',id,parent});currentImmediate=previous}},...args])};`
    files['/project/server.mjs']=setup+files['/project/server.mjs'].replace("import {createServer} from 'vite';","const {createServer}=await import('vite');")
    if(tracePool)files['/project/server.mjs']=files['/project/server.mjs'].replace('const startPoolRecord=row=>{','const startPoolRecord=row=>{row={immediate:currentImmediate,...row};')
   }
   stage('files prepared');kernel=new window.sdk.WorkerKernel(files,policy);stage('kernel constructed');timer=setTimeout(()=>{evidence.deadlineExceeded=true;stage('workflow deadline');kernel.close(new Error('Start SSR workflow deadline'))},15000)
   child=await kernel.spawn('node',['/project/server.mjs'],{cwd:'/project/app',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs',...(asyncWorkers?{NAPI_RS_ASYNC_WORK_POOL_SIZE:asyncWorkers}:{})},lifetime:'session',guestWasm:true,webAPIs:true,profileJobs,diagnostics,maxBytes:policy.maxBytes,timeoutMs:15000})
   stage('spawn returned')
   let pendingLine=''
   const capture=event=>{if(event?.type==='stdout'||event?.type==='stderr'){const text=new TextDecoder().decode(event.bytes);evidence.output=(evidence.output+text).slice(-32768);if(evidence.outputEvents.length<100)evidence.outputEvents.push({elapsedMs:elapsed(),type:event.type,text:text.slice(0,2048)});pendingLine+=text;const lines=pendingLine.split('\n');pendingLine=lines.pop().slice(traceImmediates?-32768:-4096);for(const line of lines){if(line.startsWith('START_IMMEDIATE ')&&evidence.immediates.length<1024)try{evidence.immediates.push(JSON.parse(line.slice(16)))}catch{}if(line.startsWith('START_POOL_ALLOCATION ')&&evidence.poolAllocations.length<16)try{evidence.poolAllocations.push({...JSON.parse(line.slice(22)),elapsedMs:elapsed()})}catch{}if(line.startsWith('START_HOOK ')&&evidence.hookEvents.length<256)try{evidence.hookEvents.push(JSON.parse(line.slice(11)))}catch{}if(line.startsWith('START_RUNTIME ')&&evidence.runtimeEvents.length<64)try{evidence.runtimeEvents.push({...JSON.parse(line.slice(14)),elapsedMs:elapsed()})}catch{}if(line.startsWith('START_POOL ')&&evidence.poolEvents.length<96)try{evidence.poolEvents.push({...JSON.parse(line.slice(11)),elapsedMs:elapsed()})}catch{}}}}
   for(;;){const event=await child.next();capture(event);if(evidence.output.includes('START_READY'))break;if(!event||event.type==='exit')throw Error('Start exited before ready: '+evidence.output)}
   stage('listening');await sample('listening')
   drain=(async()=>{for(;;){const event=await child.next();capture(event);if(!event||event.type==='exit')break}})().catch(error=>{evidence.output+='\noutput reader: '+error.message})
   const http=new window.sdk.WorkerHTTP(kernel,8531)
   for(const path of ['/','/about']){stage('request '+path);const response=await http.fetch(new Request('http://localhost:8531'+path));stage('headers '+path);evidence.responses.push({path,status:response.status,html:(await response.text()).slice(0,65536),elapsedMs:elapsed()});await sample('response '+path)}
  }catch(error){evidence.failure={name:error.name,message:evidence.deadlineExceeded?'Start SSR workflow deadline':error.message,underlyingMessage:error.message,stack:error.stack,elapsedMs:elapsed()};await sample('failure');if(child)try{evidence.processResult=await child.wait()}catch(waitError){evidence.processWaitError=waitError.message}}
  finally{clearTimeout(timer);if(child)try{await child.dispose()}catch(error){evidence.cleanupErrors.push(error.message)};if(drain)await drain;if(kernel)try{kernel.close()}catch(error){evidence.cleanupErrors.push(error.message)}}
  evidence.jobProfile=kernel?.jobProfile??[]
  evidence.workerLifecycle=kernel?.workerLifecycle??[]
  evidence.hostTaskScheduling=kernel?.hostTaskScheduling??[]
  evidence.profileJobs=profileJobs
  evidence.diagnostics=diagnostics
  evidence.traceWorkers=traceWorkers
  evidence.traceRuntime=traceRuntime
  evidence.tracePool=tracePool
  evidence.asyncWorkers=asyncWorkers??'package default'
  return evidence
 },{app,policy,profiler,profileJobs,diagnostics,traceWorkers,traceRuntime,tracePool,traceImmediates,resolveProbe,asyncWorkers,workerProtocol})
 const path=info.outputPath('start-vite8.json');await writeFile(path,JSON.stringify({sdkRoot,policy,closureBytes,preparation,scope:'Installed Start/Vite8 WASM dependency profile, unchanged app config, SSR only, no hydration or registry install claim',observed},null,2));await info.attach('start-vite8.json',{path,contentType:'application/json'})
 expect(Boolean(observed.failure),JSON.stringify({failure:observed.failure?{name:observed.failure.name,message:observed.failure.message.slice(0,2000),elapsedMs:observed.failure.elapsedMs}:undefined,stages:observed.stages,lastHooks:observed.hookEvents.slice(-4)})).toBe(false);expect(observed.cleanupErrors).toEqual([])
 expect(observed.responses).toHaveLength(2)
  expect(observed.responses[0].status).toBe(200);expect(observed.responses[0].html).toContain('Bare-bones Start');expect(observed.responses[0].html).toContain('TanStack Start rendered inside the browser runtime.')
 expect(observed.responses[0].html.replace(/<!--.*?-->/gs,'')).toContain('Request context: /')
 expect(observed.responses[1].status).toBe(200);expect(observed.responses[1].html).toContain('Second route')
})
