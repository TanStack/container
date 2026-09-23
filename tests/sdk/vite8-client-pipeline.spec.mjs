import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const traceCalls=process.env.VITE_PIPELINE_TRACE==='1'
const noDiscovery=process.env.VITE_PIPELINE_NO_DISCOVERY==='1'
const diagnostics=process.env.VITE_PIPELINE_DIAGNOSTICS==='1'
const traceImmediates=process.env.VITE_PIPELINE_IMMEDIATES==='1'
const traceHooks=process.env.VITE_PIPELINE_HOOKS==='1'
const traceScan=process.env.VITE_PIPELINE_SCAN==='1'
const traceRuntime=process.env.VITE_PIPELINE_RUNTIME==='1'
const tracePool=process.env.VITE_PIPELINE_POOL==='1'
const noWatch=process.env.VITE_PIPELINE_NO_WATCH==='1'
const guestBinding='/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'
const nativeBinding=resolve('fixtures/vite-rolldown-wasm/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:64*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let server,url,fixtures,preparation
test.beforeAll(async()=>{
  const publicPackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['vite'])
  const wasiPackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['@rolldown/binding-wasm32-wasi'])
  const overlaps=Object.keys(publicPackage.files).filter(path=>Object.hasOwn(wasiPackage.files,path))
  for(const path of overlaps)if(publicPackage.files[path].base64!==wasiPackage.files[path].base64)throw Error('Conflicting installed dependency closure file: '+path)
  preparation={publicPackage:publicPackage.preparation,wasiPackage:wasiPackage.preparation,identicalOverlaps:overlaps}
  fixtures=JSON.stringify({files:{...publicPackage.files,...wasiPackage.files}})
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(fixtures);return}
    try{if(!path.startsWith('/sdk/'))throw Error('outside package');const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))));if(!file.startsWith(root+sep))throw Error('outside package');res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

// Real client pipeline, with no HTTP request or iframe scheduling.
const source=`const evidence={stages:[],results:[]};let server;const phase=name=>{evidence.stages.push(name)};
try{const {createServer}=await import('vite');const fs=await import('node:fs');const root=process.cwd()+'/callable-app';fs.mkdirSync(root,{recursive:true});
fs.writeFileSync(root+'/index.html','<script type="module" src="/main.ts"></script>');
fs.writeFileSync(root+'/message.ts','export const message: string = "first version";');
fs.writeFileSync(root+'/main.ts',"import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);");
server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();phase('ready');
const paths=['/@vite/client','/main.ts'];await Promise.all(paths.map(async path=>{phase('start:'+path);const r=await server.environments.client.transformRequest(path);evidence.results.push({path,nonempty:!!r?.code,typescriptRemoved:!r?.code.includes('count: number'),hasHmr:r?.code.includes('import.meta.hot')??false});phase('done:'+path)}));
const message=await server.environments.client.transformRequest('/message.ts');evidence.message=message.code.includes('first version');evidence.results.sort((a,b)=>a.path.localeCompare(b.path));evidence.stages.sort();
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}finally{if(server)try{await server.close()}catch(error){evidence.closeError=error.message}}console.log(JSON.stringify(evidence));process.exit(evidence.failure||evidence.closeError?1:0);`;

const scenarios=[
  {includeEnv:false},
  {includeEnv:true},
  {includeEnv:true,includeHtml:true},
  {includeEnv:true,includeHtml:true,disableWarmup:true},
  {includeEnv:true,warmupOnly:true},
  {includeEnv:true,mainFirst:true},
  {includeEnv:true,duplicateMain:true},
  {includeEnv:true,duplicateMain:true,disableWarmup:true},
  {includeEnv:false,resolveOnly:true},
  {includeEnv:false,loadOnly:true},
  {includeEnv:false,loadOnly:'read'},
  {includeEnv:false,loadOnly:'transform'},
  {includeEnv:false,loadOnly:'transform-real'},
  {includeEnv:false,loadOnly:'transform-mixed'},
  {includeEnv:false,loadOnly:'transform-client'},
  {includeEnv:false,loadOnly:'transform-env'},
  ...['transform-mixed-sequential','transform-main-client','transform-main-env','transform-client-env'].map(loadOnly=>({includeEnv:false,loadOnly})),
  {includeEnv:false,loadOnly:'transform-mixed-sequential',disableWarmup:true},
  {includeEnv:false,loadOnly:'transform-serial-graph',disableWarmup:true},
  {includeEnv:false,loadOnly:'transform-graph-checkpoint',disableWarmup:true},
  {includeEnv:false,loadOnly:'transform-after-scan',disableWarmup:true},
  ...['transform-scan-ts-entry','transform-scan-html-entry','transform-scan-relative-html-entry','transform-scan-html-no-hmr','transform-scan-distinct-main','transform-scan-distinct-basic'].map(loadOnly=>({includeEnv:false,loadOnly,disableWarmup:true})),
  {includeEnv:false,loadOnly:'transform-graph-only',disableWarmup:true},
  ...['transform-scan-import-only','transform-scan-foreground-import-only'].map(loadOnly=>({includeEnv:false,loadOnly,disableWarmup:true})),
]
for(const {includeEnv,includeHtml,disableWarmup,warmupOnly,mainFirst,duplicateMain,resolveOnly,loadOnly} of scenarios)test((typeof loadOnly==='string'?`Vite plugin-container isolation ${loadOnly}`:loadOnly?'Vite three concurrent load-only requests':resolveOnly?'Vite three concurrent resolver-only requests':'Vite real client and main module transformRequest concurrently')+(includeEnv?' then env and message':'')+(includeHtml?' after HTML transform':'')+(disableWarmup?' without background preprocessing':'')+(warmupOnly?' after explicit module warmup':'')+(mainFirst?' with main requested first':'')+(duplicateMain?' with a duplicate pending main request':''),async({page},info)=>{
  let workload=includeEnv?source.replace("const message=await server.environments.client.transformRequest('/message.ts');",`const [message,env]=await Promise.all([server.environments.client.transformRequest('/message.ts'),server.environments.client.transformRequest('/@fs'+process.cwd()+'/node_modules/vite/dist/client/env.mjs')]);evidence.env={nonempty:!!env?.code,hasGlobal:env?.code.includes('globalThis')??false};`):source
  if(includeHtml)workload=workload.replace("phase('ready');",`phase('ready');const html=await server.transformIndexHtml('/',fs.readFileSync(root+'/index.html','utf8'));evidence.html={hasClient:html.includes('/@vite/client'),hasMain:html.includes('/main.ts')};`)
  if(disableWarmup)workload=workload.replace("server:{host:'127.0.0.1',port:0}","server:{host:'127.0.0.1',port:0,preTransformRequests:false}")
  if(warmupOnly)workload=workload.replace("phase('ready');","phase('ready');void server.environments.client.warmupRequest('/main.ts');")
  if(mainFirst)workload=workload.replace("const paths=['/@vite/client','/main.ts']","const paths=['/main.ts','/@vite/client']")
  if(duplicateMain)workload=workload.replace("const paths=['/@vite/client','/main.ts']","const paths=['/main.ts','/@vite/client','/main.ts']")
  if(resolveOnly){
    const start=workload.indexOf('const paths='),end=workload.indexOf('\n}catch(error)')
    if(start<0||end<start)throw Error('Resolver fixture boundaries missing')
    workload=workload.slice(0,start)+`const paths=['/main.ts','/@vite/client','/main.ts'];await Promise.all(paths.map(async path=>{const r=await server.environments.client.pluginContainer.resolveId(path);evidence.results.push({path,file:r?.id?.split('/').at(-1)})}));evidence.results.sort((a,b)=>a.path.localeCompare(b.path));`+workload.slice(end)
  }
  if(loadOnly){
    const start=workload.indexOf('const paths='),end=workload.indexOf('\n}catch(error)')
    if(start<0||end<start)throw Error('Load fixture boundaries missing')
    workload=workload.slice(0,start)+`const paths=[root+'/main.ts',process.cwd()+'/node_modules/vite/dist/client/env.mjs',root+'/main.ts'];await Promise.all(paths.map(async path=>{const r=await server.environments.client.pluginContainer.load(path);evidence.results.push({file:path.split('/').at(-1),kind:r===null?'null':typeof r,nonempty:typeof r==='string'?r.length>0:!!r?.code})}));evidence.results.sort((a,b)=>a.file.localeCompare(b.file));`+workload.slice(end)
    if(loadOnly==='read')workload=workload.replace("const r=await server.environments.client.pluginContainer.load(path);","const loaded=await server.environments.client.pluginContainer.load(path);const r=loaded??await fs.promises.readFile(path,'utf8');")
    if(loadOnly==='transform')workload=workload.replace("const paths=[root+'/main.ts',process.cwd()+'/node_modules/vite/dist/client/env.mjs',root+'/main.ts'];", "const preparedModule=await server.environments.client.moduleGraph.ensureEntryFromUrl('/main.ts');const paths=[preparedModule.id,preparedModule.id,preparedModule.id];").replace("const r=await server.environments.client.pluginContainer.load(path);", "const r=await server.environments.client.pluginContainer.transform('export const count: number=42;',path);")
    if(typeof loadOnly==='string'&&loadOnly.startsWith('transform-')){
      let urls=loadOnly==='transform-real'?"['/main.ts','/main.ts','/main.ts']":loadOnly==='transform-client'?"Array(3).fill('/@vite/client')":loadOnly==='transform-env'?"Array(3).fill('/@fs'+process.cwd()+'/node_modules/vite/dist/client/env.mjs')":"['/main.ts','/@vite/client','/@fs'+process.cwd()+'/node_modules/vite/dist/client/env.mjs']"
      if(loadOnly==='transform-main-client')urls="['/main.ts','/@vite/client']"
      if(loadOnly==='transform-main-env')urls="['/main.ts','/@fs'+process.cwd()+'/node_modules/vite/dist/client/env.mjs']"
      if(loadOnly==='transform-client-env')urls="['/@vite/client','/@fs'+process.cwd()+'/node_modules/vite/dist/client/env.mjs']"
      if(['transform-scan-distinct-main','transform-scan-distinct-basic','transform-scan-import-only','transform-scan-foreground-import-only'].includes(loadOnly)){
        urls="['/main.ts','/second.ts','/third.ts']"
        workload=workload.replace("phase('ready');","phase('ready');for(const name of ['second.ts','third.ts'])fs.writeFileSync(root+'/'+name,fs.readFileSync(root+'/main.ts','utf8'));")
      }
      workload=workload.replace("const paths=[root+'/main.ts',process.cwd()+'/node_modules/vite/dist/client/env.mjs',root+'/main.ts'];",`const prepared=await Promise.all(${urls}.map(url=>server.environments.client.moduleGraph.ensureEntryFromUrl(url)));const paths=prepared.map(module=>module.id);`)
        .replace("const r=await server.environments.client.pluginContainer.load(path);", "const loaded=await server.environments.client.pluginContainer.load(path);const code=typeof loaded==='string'?loaded:loaded?.code??await fs.promises.readFile(path,'utf8');const r=await server.environments.client.pluginContainer.transform(code,path);")
      if(['transform-mixed-sequential','transform-serial-graph','transform-graph-checkpoint'].includes(loadOnly)||loadOnly.startsWith('transform-scan-'))workload=workload.replace('await Promise.all(paths.map(async path=>{','for(const path of paths){').replace('}));evidence.results.sort','};evidence.results.sort')
      if(loadOnly==='transform-serial-graph')workload=workload.replace(`const prepared=await Promise.all(${urls}.map(url=>server.environments.client.moduleGraph.ensureEntryFromUrl(url)));`,`const prepared=[];for(const url of ${urls})prepared.push(await server.environments.client.moduleGraph.ensureEntryFromUrl(url));`)
      if(loadOnly==='transform-graph-checkpoint'||loadOnly.startsWith('transform-scan-'))workload=workload.replace('const paths=prepared.map',"console.log('PIPELINE_PHASE graph-ready');await new Promise(resolve=>setImmediate(resolve));console.log('PIPELINE_PHASE after-checkpoint');const paths=prepared.map")
      if(loadOnly.startsWith('transform-scan-'))workload=workload.replace('configFile:false,',`configFile:false,optimizeDeps:{entries:[${JSON.stringify(loadOnly==='transform-scan-ts-entry'?'main.ts':'index.html')}]},`)
      if(loadOnly==='transform-scan-relative-html-entry')workload=workload.replace('src="/main.ts"','src="./main.ts"')
      if(loadOnly==='transform-scan-html-no-hmr')workload=workload.replace("if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);",'')
      if(loadOnly==='transform-scan-distinct-basic')workload=workload.replace("import {message} from './message';","const message='first version';").replace("if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);",'')
      if(['transform-scan-import-only','transform-scan-foreground-import-only'].includes(loadOnly)){
        const importStatement="import {message} from './message';",hmr="if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);"
        workload=workload.replace('server=await createServer',`const importedSource=fs.readFileSync(root+'/main.ts','utf8'),basicSource=importedSource.replace(${JSON.stringify(importStatement)},"const message='first version';").replace(${JSON.stringify(hmr)},'');fs.writeFileSync(root+'/scanner.ts',${loadOnly==='transform-scan-import-only'?'importedSource':'basicSource'});${loadOnly==='transform-scan-import-only'?"fs.writeFileSync(root+'/main.ts',basicSource);":''}fs.writeFileSync(root+'/index.html','<script type="module" src="/scanner.ts"></script>');server=await createServer`)
      }
      // Diagnostic only: separate dependency scanning from foreground module work.
      // This must never replace the concurrent application acceptance fixture.
      if(loadOnly==='transform-after-scan')workload=workload.replace("phase('ready');","phase('ready');const scan=server.environments.client.depsOptimizer?.scanProcessing;if(!scan)throw Error('Expected active dependency scan');await scan;console.log('PIPELINE_PHASE scan-finished');")
      if(loadOnly==='transform-graph-only'){
        const start=workload.indexOf('const paths=prepared.map'),end=workload.indexOf('\n}catch(error)')
        if(start<0||end<start)throw Error('Graph fixture boundaries missing')
        workload=workload.slice(0,start)+`evidence.results=prepared.map(module=>({file:module.id.split('/').at(-1),nonempty:!!module.id})).sort((a,b)=>a.file.localeCompare(b.file));`+workload.slice(end)
      }
    }
    workload=workload.replace('const evidence={stages:',`const evidence={isolation:${JSON.stringify(loadOnly)},stages:`)
  }
  if(traceCalls)workload=workload.replace("phase('ready');",`phase('ready');let calls=0;const container=server.environments.client.pluginContainer;for(const name of ['resolveId','load','transform']){const original=container[name];container[name]=function(...args){if(calls++<96)console.log('PIPELINE_CALL '+JSON.stringify({method:name,id:String(args[name==='transform'?1:0]).slice(0,200)}));return original.apply(this,args)}};`)
  if(traceHooks){
    workload=`let activePipelineHook;\n`+workload.replace("phase('ready');",`phase('ready');let hookCalls=0;const tracedContainer=server.environments.client.pluginContainer;for(const name of ['resolveId','load','transform'])for(const plugin of tracedContainer.getSortedPlugins(name)){const hook=plugin[name],handler=typeof hook==='function'?hook:hook.handler;const wrapped=function(...args){const label={plugin:plugin.name,method:name,id:String(args[name==='transform'?1:0]).slice(0,200),scan:name==='resolveId'?!!args[2]?.scan:undefined};if(hookCalls++<192)console.log('PIPELINE_HOOK '+JSON.stringify(label));const previous=activePipelineHook;activePipelineHook=label;try{return handler.apply(this,args)}finally{activePipelineHook=previous}};plugin[name]=typeof hook==='function'?Object.assign(wrapped,hook):{...hook,handler:wrapped}};`)
  }
  if(noDiscovery)workload=workload.replace('configFile:false,','configFile:false,optimizeDeps:{noDiscovery:true},')
  // Supported Vite configuration. Also disables its resolver cache, so this
  // comparison alone cannot attribute a difference exclusively to watching.
  if(noWatch)workload=workload.replace("server:{host:'127.0.0.1'","server:{watch:null,host:'127.0.0.1'")
  if(traceScan)workload=workload.replace("phase('ready');",`phase('ready');const tracedScan=server.environments.client.depsOptimizer?.scanProcessing;console.log('PIPELINE_SCAN '+JSON.stringify({phase:'observed',active:!!tracedScan}));if(tracedScan)tracedScan.then(()=>console.log('PIPELINE_SCAN '+JSON.stringify({phase:'settled'})),error=>console.log('PIPELINE_SCAN '+JSON.stringify({phase:'rejected',message:String(error?.message).slice(0,300)})));`)
  // This installed Vite imports Rolldown's binding before import('vite') resolves.
  // Observe explicit JS lifecycle calls on its cached export object, not hidden
  // Rust lifecycle transitions. Keep calls synchronous and return values intact.
  if(traceRuntime){
    workload=`const hookOrigins=new WeakMap();let snapshotTrackedHooks=()=>({available:false});\n`+workload
    // Reuse Vite's own tracking set, without attaching then/finally observers.
    workload=workload.replace("phase('ready');",`phase('ready');const lifecycleContainer=server.environments.client.pluginContainer;if(!(lifecycleContainer._processesing instanceof Set))throw Error('Expected Vite hook tracking set');snapshotTrackedHooks=()=>({available:true,total:lifecycleContainer._processesing.size,hooks:Array.from(lifecycleContainer._processesing).slice(0,32).map(promise=>hookOrigins.get(promise)??{known:false})});for(const method of ['resolveId','load','transform'])for(const plugin of lifecycleContainer.getSortedPlugins(method)){const hook=plugin[method],handler=typeof hook==='function'?hook:hook.handler;const wrapped=function(...args){const result=handler.apply(this,args);if(result?.then)hookOrigins.set(result,{plugin:plugin.name,method,id:String(args[method==='transform'?1:0]).slice(0,200),scan:method==='resolveId'?!!args[2]?.scan:undefined});return result};plugin[method]=typeof hook==='function'?Object.assign(wrapped,hook):{...hook,handler:wrapped}};`)
    workload=workload.replace("const {createServer}=await import('vite');",`const {createServer}=await import('vite');const {t:cachedBinding}=await import(process.cwd()+'/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs');const lifecycleBinding=cachedBinding();let runtimeEvents=0;const runtimeEvent=(method,phase)=>{if(runtimeEvents++<32)console.log('PIPELINE_RUNTIME '+JSON.stringify({method,phase,trackedHooks:snapshotTrackedHooks()}))};for(const method of ['startAsyncRuntime','shutdownAsyncRuntime']){const original=lifecycleBinding[method];if(typeof original!=='function')throw Error('Missing runtime lifecycle export: '+method);lifecycleBinding[method]=function(...args){runtimeEvent(method,'enter');try{const result=Reflect.apply(original,this,args);runtimeEvent(method,'return');return result}catch(error){runtimeEvent(method,'throw');throw error}}}`)
  }
  if(tracePool){
    // Observe the actual installed pool class before the binding constructs it.
    // Keep these synchronous methods synchronous, including their return/throw.
    workload=`const {ThreadManager:PoolManager}=await import('@emnapi/wasi-threads');
const poolIds=new WeakMap();let poolId=0,poolEvents=0;const poolTotals={get:0,returns:0,allocations:0,throws:0};
const poolIdentity=worker=>{if(!worker)return undefined;if(!poolIds.has(worker))poolIds.set(worker,++poolId);return poolIds.get(worker)};
const poolSnapshot=pool=>({idle:pool.unusedWorkers.length,active:Object.keys(pool.pthreads).length,workers:pool.unusedWorkers.slice(0,12).map(poolIdentity),tids:Object.keys(pool.pthreads).slice(0,12)});
const poolTrace=row=>{if(poolEvents++<64)console.log('PIPELINE_POOL '+JSON.stringify({...row,hook:typeof activePipelineHook==='undefined'?undefined:activePipelineHook,immediate:typeof immediateCurrent==='number'?immediateCurrent:undefined,totals:{...poolTotals}}))};
for(const method of ['getNewWorker','returnWorkerToPool']){const original=PoolManager.prototype[method];if(typeof original!=='function')throw Error('Missing pool method '+method);PoolManager.prototype[method]=function(...args){const allocation=method==='getNewWorker'&&this.unusedWorkers.length===0;poolTotals[method==='getNewWorker'?'get':'returns']++;if(allocation)poolTotals.allocations++;const before=poolSnapshot(this),stack=allocation?new Error().stack?.split('\\n'):undefined,caller=stack?.slice(2,7).join(' ').slice(0,900),outerCaller=stack?.slice(-7).join(' ').slice(0,1200);try{const result=Reflect.apply(original,this,args);poolTrace({method,phase:'return',allocation,worker:poolIdentity(method==='getNewWorker'?result:args[0]),before,after:poolSnapshot(this),caller,outerCaller});return result}catch(error){poolTotals.throws++;poolTrace({method,phase:'throw',allocation,before,after:poolSnapshot(this),caller,outerCaller});throw error}}}
`+workload
  }
  if(traceImmediates){
    workload=`let traceImmediateEnabled=false,immediateSequence=0,immediateCurrent=0,immediateEvents=0;const pendingImmediateIds=new Set(),immediateHandles=new Map(),originalImmediate=globalThis.setImmediate,originalClearImmediate=globalThis.clearImmediate;
const immediateTotals={queued:0,begun:0,ended:0,cancelled:0,maxPending:0};
const immediateTrace=row=>{if(traceImmediateEnabled&&immediateEvents++<192)console.log('PIPELINE_IMMEDIATE '+JSON.stringify(row))};
globalThis.setImmediate=function(callback,...args){const id=++immediateSequence,parent=immediateCurrent;pendingImmediateIds.add(id);immediateTotals.queued++;immediateTotals.maxPending=Math.max(immediateTotals.maxPending,pendingImmediateIds.size);immediateTrace({phase:'queued',id,parent,pending:pendingImmediateIds.size,caller:new Error().stack?.split('\\n').slice(2,4).join(' ').slice(0,300)});const handle=originalImmediate(function(...values){pendingImmediateIds.delete(id);immediateHandles.delete(handle);immediateTotals.begun++;const previous=immediateCurrent;immediateCurrent=id;immediateTrace({phase:'begin',id,pending:pendingImmediateIds.size});try{return callback.apply(this,values)}finally{immediateTotals.ended++;immediateTrace({phase:'end',id,pending:pendingImmediateIds.size});immediateCurrent=previous}},...args);immediateHandles.set(handle,id);return handle};
globalThis.clearImmediate=function(handle){const result=originalClearImmediate(handle),id=immediateHandles.get(handle);if(id!==undefined){immediateHandles.delete(handle);pendingImmediateIds.delete(id);immediateTotals.cancelled++;immediateTrace({phase:'cancel',id,pending:pendingImmediateIds.size})}return result};
const immediateSummary=()=>console.log('PIPELINE_IMMEDIATE_TOTALS '+JSON.stringify({...immediateTotals,pending:pendingImmediateIds.size,detailEvents:immediateEvents,scope:'since trace wrapper installation'}));
`+workload.replace("phase('ready');","phase('ready');traceImmediateEnabled=true;").replace('console.log(JSON.stringify(evidence));','immediateSummary();console.log(JSON.stringify(evidence));')
  }
  test.skip(!['experimental-fibers-simd','experimental-fibers-simd-lazy','experimental-fibers-simd-lazy-initializers-o2-assignments'].includes(manifest.buildProfile),'Requires SIMD fiber package')
  test.setTimeout(60000)
  const nativeApp=mkdtempSync(join(tmpdir(),'vite-callable-native-'))
  // Count real worker instances independently from callback traces. Native is
  // not memory-limited like the guest, so native success alone is insufficient.
  const nativeCounter=`const workerModule=(await import('node:worker_threads')).default,OriginalWorker=workerModule.Worker;
const nativeWorkers={created:0,active:0,peak:0,exited:0};workerModule.Worker=class extends OriginalWorker{constructor(...args){super(...args);nativeWorkers.created++;nativeWorkers.active++;nativeWorkers.peak=Math.max(nativeWorkers.peak,nativeWorkers.active);this.once('exit',()=>{nativeWorkers.active--;nativeWorkers.exited++})}};(await import('node:module')).syncBuiltinESMExports();\n`;
  const nativeSource=nativeCounter+workload.replace("process.cwd()+'/callable-app'",JSON.stringify(nativeApp)).replace('console.log(JSON.stringify(evidence));',"console.log('PIPELINE_NATIVE_WORKERS '+JSON.stringify(nativeWorkers));console.log(JSON.stringify(evidence));")
  const native=spawnSync(process.execPath,['--input-type=module','-e',nativeSource],{cwd:resolve('fixtures/vite-rolldown-wasm'),env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:nativeBinding},encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-vite8-client-pipeline.json')
  await writeFile(nativePath,JSON.stringify({traceCalls,noDiscovery,noWatch,traceImmediates,traceHooks,traceScan,traceRuntime,tracePool,status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message,binding:nativeBinding},null,2));await info.attach('native-vite8-client-pipeline.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1))
  expect(expected.failure).toBeUndefined();expect(expected.results).toHaveLength(['transform-main-client','transform-main-env','transform-client-env'].includes(loadOnly)?2:duplicateMain||resolveOnly||loadOnly?3:2)
  if(loadOnly===true)expect(expected.results).toEqual([{file:'env.mjs',kind:'null',nonempty:false},{file:'main.ts',kind:'null',nonempty:false},{file:'main.ts',kind:'null',nonempty:false}])
  else if(loadOnly)expect(expected.results.every(r=>r.nonempty)).toBe(true)
  else if(resolveOnly)expect(expected.results).toEqual([{path:'/@vite/client',file:'client.mjs'},{path:'/main.ts',file:'main.ts'},{path:'/main.ts',file:'main.ts'}])
  else {expect(expected.results.every(r=>r.nonempty&&r.typescriptRemoved)).toBe(true);expect(expected.message).toBe(true)}
  if(includeEnv)expect(expected.env).toEqual({nonempty:true,hasGlobal:true})
  if(includeHtml)expect(expected.html).toEqual({hasClient:true,hasMain:true})
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async({source,policy,guestBinding,diagnostics})=>{
    const snapshot=await fetch('/fixture.json').then(r=>r.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
    files['/project/main.mjs']=source
    const kernel=new window.sdk.WorkerKernel(files,policy);const output=[];let result,error,closeError,jobProfile
    try{result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:guestBinding},guestWasm:true,webAPIs:true,diagnostics,maxBytes:policy.maxBytes,timeoutMs:15000,onOutput:(level,text)=>output.push({level,text})})}catch(e){error={name:e.name,message:e.message}}
    finally{jobProfile=kernel.jobProfile.slice(0,100);try{kernel.close()}catch(e){closeError={message:e.message}}}
    return {result,error,closeError,output,diagnostics,jobProfile,workerLifecycle:kernel.workerLifecycle}
  },{source:workload,policy,guestBinding,diagnostics})
  const path=info.outputPath('guest-vite8-client-pipeline.json');await writeFile(path,JSON.stringify({root,policy,traceCalls,noDiscovery,noWatch,traceImmediates,traceHooks,traceScan,traceRuntime,tracePool,scenario:{includeEnv,includeHtml:!!includeHtml,disableWarmup:!!disableWarmup,warmupOnly:!!warmupOnly,mainFirst:!!mainFirst,duplicateMain:!!duplicateMain,resolveOnly:!!resolveOnly,loadOnly:loadOnly??false},guestBinding,preparation,expected,observed},null,2));await info.attach('guest-vite8-client-pipeline.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  expect(JSON.parse(observed.result.stdout.trim().split('\n').at(-1))).toEqual(expected)
  expect(observed.closeError).toBeUndefined()
})
