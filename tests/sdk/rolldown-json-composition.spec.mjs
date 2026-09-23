import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const guestBinding='/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'
const nativeBinding=resolve('fixtures/vite-rolldown-wasm/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const diagnostics=process.env.ROLLDOWN_COMPOSITION_DIAGNOSTICS==='1'
const traceImmediates=process.env.ROLLDOWN_COMPOSITION_IMMEDIATES==='1'
const traceCallbacks=process.env.ROLLDOWN_COMPOSITION_CALLBACKS==='1'
const traceAwaits=process.env.ROLLDOWN_COMPOSITION_AWAITS==='1'
const traceLifecycleImports=process.env.ROLLDOWN_COMPOSITION_LIFECYCLE_IMPORTS==='1'
if(traceLifecycleImports&&!traceCallbacks)throw Error('Lifecycle import tracing requires ROLLDOWN_COMPOSITION_CALLBACKS=1')
if(traceAwaits&&!traceImmediates)throw Error('Await tracing requires ROLLDOWN_COMPOSITION_IMMEDIATES=1')
if(traceCallbacks&&!traceImmediates)throw Error('Callback tracing requires ROLLDOWN_COMPOSITION_IMMEDIATES=1')
if(process.env.ROLLDOWN_WORKER_MIB!==undefined&&!['64','128'].includes(process.env.ROLLDOWN_WORKER_MIB))throw Error('ROLLDOWN_WORKER_MIB supports only 64 or 128')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:Number(process.env.ROLLDOWN_WORKER_MIB??64)*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let server,url,fixtures,mixedFixtures,preparation
test.beforeAll(async()=>{
  const publicPackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['rolldown'])
  const wasiPackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['@rolldown/binding-wasm32-wasi'])
  const overlaps=Object.keys(publicPackage.files).filter(path=>Object.hasOwn(wasiPackage.files,path))
  for(const path of overlaps)if(publicPackage.files[path].base64!==wasiPackage.files[path].base64)throw Error('Conflicting installed dependency closure file: '+path)
  preparation={publicPackage:publicPackage.preparation,wasiPackage:wasiPackage.preparation,identicalOverlaps:overlaps}
  fixtures=JSON.stringify({files:{...publicPackage.files,...wasiPackage.files}})
  const vitePackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['vite'])
  const merged={...publicPackage.files,...wasiPackage.files},viteOverlaps=[]
  for(const [path,value] of Object.entries(vitePackage.files)){if(Object.hasOwn(merged,path)){if(merged[path].base64!==value.base64)throw Error('Conflicting Vite dependency closure file: '+path);viteOverlaps.push(path)}merged[path]=value}
  preparation.vitePackage=vitePackage.preparation;preparation.viteIdenticalOverlaps=viteOverlaps
  mixedFixtures=JSON.stringify({files:merged})
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(fixtures);return}
    if(path==='/mixed-fixture.json'){res.setHeader('content-type','application/json');res.end(mixedFixtures);return}
    try{if(!path.startsWith('/sdk/'))throw Error('outside package');const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))));if(!file.startsWith(root+sep))throw Error('outside package');res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})


for(const mode of ['sequential','concurrent','microtask-interleaved','build-then-hooks','build-with-hooks','scan-html-then-hooks','scan-html-with-hooks','scan-html-chain-then-hooks','scan-html-chain-with-hooks','scan-html-full-hooks','scan-html-full-serial-after-scan','scan-html-full-basic-serial-with-scan','scan-html-full-basic-serial-graph-with-scan','scan-html-full-basic-serial-graph-serial-with-scan','scan-html-full-basic-serial-graph-no-checkpoint-with-scan','scan-html-mixed-hooks','scan-html-mixed-overlap-graph','runtime-shutdown-pending-transform'])test('Rolldown preview JSON hook composition '+mode,async({page},info)=>{
  test.setTimeout(60000)
  let source=`
const evidence={mode:${JSON.stringify(mode)},stages:[],results:[]};const live=new Set();
if(process.env.COUNT_NATIVE_WORKERS==='1'){const mod=(await import('node:worker_threads')).default,Original=mod.Worker;evidence.workers={created:0,peak:0,exited:0};mod.Worker=class extends Original{constructor(...args){super(...args);live.add(this);evidence.workers.created++;evidence.workers.peak=Math.max(evidence.workers.peak,live.size);this.once('exit',()=>{live.delete(this);evidence.workers.exited++})}};(await import('node:module')).syncBuiltinESMExports()}

try{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 await fs.mkdir(os.tmpdir(),{recursive:true});
 const project=await fs.mkdtemp(path.join(os.tmpdir(),'rolldown-relative-'));const realProject=evidence.mode.startsWith('scan-html-full-basic-serial-graph-')?await fs.realpath(project):project;
 await fs.writeFile(path.join(project,'message.ts'),'export const message: string = "first version";');
 const code="import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);";
 const {transformSync}=await import('rolldown/utils');const {oxcRuntimePlugin,viteResolvePlugin,viteJsonPlugin}=await import('rolldown/experimental');
 const plugin=oxcRuntimePlugin(),handler=typeof plugin.transform==='function'?plugin.transform:plugin.transform.handler;
 const resolver=viteResolvePlugin({resolveOptions:{isBuild:false,isProduction:false,asSrc:true,preferRelative:false,root:project,scan:false,mainFields:['browser','module','jsnext:main','jsnext','main'],conditions:['module','browser','development'],externalConditions:['node'],extensions:['.mjs','.js','.mts','.ts','.jsx','.tsx','.json'],tryIndex:true,preserveSymlinks:false,tsconfigPaths:false},environmentConsumer:'client',environmentName:'client',builtins:[],external:[],noExternal:[],dedupe:[],resolveSubpathImports:()=>undefined});
 const nativeResolveId=typeof resolver.resolveId==='function'?resolver.resolveId:resolver.resolveId.handler;
 const shutdownPending=evidence.mode==='runtime-shutdown-pending-transform',mixedHooks=evidence.mode.startsWith('scan-html-mixed-'),fullHooks=evidence.mode.startsWith('scan-html-full-')||mixedHooks||shutdownPending,chainMode=evidence.mode.startsWith('scan-html-chain-')||fullHooks,pendingHooks=new Set();let mixedPaths;
 const runtimeResolveId=typeof plugin.resolveId==='function'?plugin.resolveId:plugin.resolveId?.handler;
 const tracked=value=>{if(!value?.then)return value;pendingHooks.add(value);return value.finally(()=>pendingHooks.delete(value))};
 if(chainMode)evidence.chain={scanner:0,foreground:0,runtimeNull:0};
 const resolveId=function(id,importer,options){if(!chainMode)return nativeResolveId.call(this,id,importer,options);return (async()=>{const normalized={...options,scan:!!options.scan};evidence.chain[normalized.scan?'scanner':'foreground']++;const runtimeResult=await tracked(runtimeResolveId.call(this,id,importer,normalized));if(runtimeResult!=null)throw Error('Expected null runtime resolver result');evidence.chain.runtimeNull++;return await tracked(nativeResolveId.call(this,id,importer,normalized))})()};
 const json=viteJsonPlugin({namedExports:true,stringify:'auto',minify:false});const hook=name=>typeof json[name]==='function'?json[name]:json[name]?.handler;
 evidence.stages.push('imported');
 const basicSerial=evidence.mode.startsWith('scan-html-full-basic-serial-'),basicGraph=evidence.mode.startsWith('scan-html-full-basic-serial-graph-'),serialGraph=evidence.mode==='scan-html-full-basic-serial-graph-serial-with-scan',graphCheckpoint=evidence.mode!=='scan-html-full-basic-serial-graph-no-checkpoint-with-scan';let basicPaths;
 const basicCode="const message='first version';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;";
 const run=async i=>{evidence.stages.push('start-'+i);const filename=mixedHooks?mixedPaths[i]:basicGraph?basicPaths[i]:path.join(project,'main-'+i+'.ts');
  if(fullHooks){
   const get=(plugin,name)=>typeof plugin[name]==='function'?plugin[name]:plugin[name]?.handler;
   const loads=[];let current=mixedHooks||basicSerial?await fs.readFile(filename,'utf8'):code;
   for(const item of [plugin,resolver,json]){const value=await tracked(get(item,'load').call({},filename,{ssr:false}));loads.push(value??null);if(value!=null){current=typeof value==='string'?value:value.code;break}}
   const transforms=[];let moduleType=filename.endsWith('.ts')?'ts':'js';
   for(const item of [resolver,plugin]){const value=await tracked(get(item,'transform').call({},current,filename,{ssr:false,moduleType}));transforms.push(value??null);if(typeof value==='string')current=value;else if(value){current=value.code??current;moduleType=value.moduleType??moduleType}}
   const r=transformSync(filename,current,{lang:moduleType,sourcemap:true});current=r.code;
   const jsonResult=await tracked(hook('transform').call({},current,filename,{ssr:false,moduleType:'js'}));if(typeof jsonResult==='string')current=jsonResult;else if(jsonResult?.code!==undefined)current=jsonResult.code;
   const resolution=basicSerial||mixedHooks&&i>0?null:await resolveId.call({},'./message',filename,{isEntry:false,kind:'import-statement'});const id=typeof resolution==='string'?resolution:resolution?.id;
   evidence.stages.push('done-'+i);return {code:current,errors:r.errors,resolved:id?path.basename(id):null,loads,transforms,jsonTransform:jsonResult??null};
  }
  const loaded=await hook('load').call({},filename,{ssr:false});const first=await handler.call({},code,filename,{ssr:false,moduleType:'ts'});const r=transformSync(filename,first?.code??code,{lang:'ts',sourcemap:true});const jsonResult=await hook('transform').call({},r.code,filename,{ssr:false,moduleType:'js'});const resolution=await resolveId.call({},'./message',filename,{isEntry:false,kind:'import-statement'});const id=typeof resolution==='string'?resolution:resolution?.id;evidence.stages.push('done-'+i);return {code:r.code,errors:r.errors,resolved:id?path.basename(id):null,jsonLoad:loaded??null,jsonTransform:jsonResult??null}};
 if(shutdownPending){
  const {pathToFileURL}=await import('node:url');const bindingDirectory=path.join(process.cwd(),'node_modules/rolldown/dist/shared');const bindingFiles=(await fs.readdir(bindingDirectory)).filter(name=>name.startsWith('binding-')&&name.endsWith('.mjs'));if(bindingFiles.length!==1)throw Error('Expected one installed shared binding module');
  const binding=(await import(pathToFileURL(path.join(bindingDirectory,bindingFiles[0])).href)).t();
  binding.startAsyncRuntime();evidence.stages.push('runtime-start');
  const pending=tracked(handler.call({},code,path.join(project,'overlap.ts'),{ssr:false,moduleType:'ts'}));evidence.stages.push('transform-invoked');
  binding.shutdownAsyncRuntime();evidence.stages.push('runtime-shutdown');
  evidence.overlap=(await pending)??null;evidence.stages.push('transform-awaited');
  for(let i=0;i<3;i++)evidence.results.push(await run(i));
 }else if(evidence.mode.startsWith('scan-html-')){
  await fs.writeFile(path.join(project,'index.html'),'<html><head></head><body><script type="module" src="./entry.ts"></script></body></html>');
  await fs.writeFile(path.join(project,'entry.ts'),"import {message} from './message'; export const result: string = message + ':42';");
  const {scan}=await import('rolldown/experimental');
  if(basicSerial)for(let i=0;i<3;i++)await fs.writeFile(path.join(project,'main-'+i+'.ts'),basicCode);
  if(mixedHooks)await fs.writeFile(path.join(project,'main.ts'),code);
  const prepareMixed=async()=>{evidence.stages.push('graph-start');const paths=[path.join(project,'main.ts'),path.join(process.cwd(),'node_modules/vite/dist/client/client.mjs'),path.join(process.cwd(),'node_modules/vite/dist/client/env.mjs')];mixedPaths=await Promise.all(paths.map(async id=>{const result=await resolveId.call({},id,path.join(project,'index.html'),{isEntry:false,kind:'import-statement'});const resolved=typeof result==='string'?result:result?.id;if(!resolved)throw Error('Unresolved mixed input: '+id);return resolved}));evidence.prepared=mixedPaths.map(id=>path.basename(id));evidence.stages.push('graph-ready')};
  if(mixedHooks&&evidence.mode!=='scan-html-mixed-overlap-graph')await prepareMixed();
  const performScan=async()=>{evidence.stages.push('scan-start');const visited=new Set(),resolved=new Set();let extractedSource;
   await scan({input:path.join(project,'index.html'),cwd:project,plugins:[{name:'html-scan-reentry',
    async resolveId(id,importer){const resolution=await resolveId.call({},id,importer,{isEntry:!importer,kind:'import-statement',...(chainMode?{scan:true}:{})});const target=typeof resolution==='string'?resolution:resolution?.id;if(target){resolved.add(path.basename(target));return target}},
    async load(id){visited.add(path.basename(id));if(id.endsWith('.html')){const html=await fs.readFile(id,'utf8');const match=html.match(/src="([^"]+)"/);if(!match)throw Error('Missing script source');extractedSource='import '+JSON.stringify(match[1])+'; export default {}';return {code:extractedSource,moduleType:'js'}}}
   }]});evidence.scan={visited:[...visited].sort(),resolved:[...resolved].sort(),extractedSource};evidence.stages.push('scan-done')};
  if(evidence.mode==='scan-html-mixed-overlap-graph'){const scanning=performScan();const foreground=(async()=>{await prepareMixed();evidence.results=await Promise.all([0,1,2].map(run))})();await Promise.all([scanning,foreground])}
  else if(basicSerial){const scanning=performScan();if(basicGraph){evidence.stages.push('graph-start');const prepare=async i=>{const url='/main-'+i+'.ts';const result=await resolveId.call({},url,path.join(project,'index.html'),{kind:undefined,attributes:{},custom:undefined,isEntry:false,ssr:false,scan:false});const resolved=typeof result==='string'?result:result?.id;if(resolved!==path.join(realProject,'main-'+i+'.ts'))throw Error('Unexpected foreground graph resolution: '+resolved);return resolved};if(serialGraph){basicPaths=[];for(const i of [0,1,2])basicPaths.push(await prepare(i))}else basicPaths=await Promise.all([0,1,2].map(prepare));evidence.prepared=basicPaths.map(id=>path.basename(id));evidence.stages.push('graph-ready');if(graphCheckpoint){await new Promise(resolve=>setImmediate(resolve));evidence.stages.push('after-checkpoint')}}for(let i=0;i<3;i++)evidence.results.push(await run(i));await scanning}
  else if(evidence.mode==='scan-html-full-serial-after-scan'){await performScan();for(let i=0;i<3;i++)evidence.results.push(await run(i))}
  else if(evidence.mode.endsWith('-then-hooks')){await performScan();evidence.results=await Promise.all([0,1,2].map(run))}
  else{const results=await Promise.all([performScan(),...([0,1,2].map(run))]);evidence.results=results.slice(1)}
 }else if(evidence.mode.startsWith('build-')){
  await fs.writeFile(path.join(project,'entry.ts'),"import {message} from './message'; export const result: string = message + ':42';");
  const {rolldown}=await import('rolldown');
  const build=async()=>{evidence.stages.push('build-start');const bundle=await rolldown({input:path.join(project,'entry.ts'),cwd:project});try{const generated=await bundle.generate({format:'iife',name:'ProbeBuild'});const chunks=generated.output.filter(item=>item.type==='chunk');evidence.build={chunks:chunks.length,result:chunks.length===1?new Function(chunks[0].code+';return ProbeBuild.result')():null};evidence.stages.push('build-done')}finally{await bundle.close()}};
  if(evidence.mode==='build-then-hooks'){await build();evidence.results=await Promise.all([0,1,2].map(run))}
  else{const results=await Promise.all([build(),...([0,1,2].map(run))]);evidence.results=results.slice(1)}
 }else if(evidence.mode==='sequential'){for(let i=0;i<3;i++)evidence.results.push(await run(i))}
 else if(evidence.mode==='microtask-interleaved'){
  const pause=async()=>{for(let step=0;step<4;step++)await Promise.resolve()};
  for(let round=0;round<2;round++)evidence.results.push(...await Promise.all([0,1,2].map(async i=>{await pause();const result=await run(round*3+i);await pause();return result})));
 }else evidence.results=await Promise.all([0,1,2].map(run));
 if(chainMode)evidence.chain.pending=pendingHooks.size;
}catch(e){evidence.failure={name:e.name,message:e.message}}

if(evidence.workers){const guard=setTimeout(()=>process.exit(124),1000);await Promise.allSettled([...live].map(worker=>worker.terminate()));clearTimeout(guard);evidence.workers.remaining=live.size}
console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);
`
  if(diagnostics){
    source=source.replace('try{\n const fs=',`let activeCompositionHook;\ntry{\n const fs=`)
    source=source.replace(" const {transformSync}=await import('rolldown/utils');",`const {ThreadManager:PoolManager}=await import('@emnapi/wasi-threads');
const poolIds=new WeakMap();let poolId=0,poolEvents=0;const poolTotals={get:0,returns:0,allocations:0,throws:0};
const poolIdentity=worker=>{if(!worker)return undefined;if(!poolIds.has(worker))poolIds.set(worker,++poolId);return poolIds.get(worker)};
const poolSnapshot=pool=>({idle:pool.unusedWorkers.length,active:Object.keys(pool.pthreads).length,workers:pool.unusedWorkers.slice(0,12).map(poolIdentity),tids:Object.keys(pool.pthreads).slice(0,12)});
const poolTrace=row=>{if(poolEvents++<64)console.log('COMPOSITION_POOL '+JSON.stringify({...row,stage:evidence.stages.at(-1),hook:activeCompositionHook,totals:{...poolTotals}}))};
for(const method of ['getNewWorker','returnWorkerToPool']){const original=PoolManager.prototype[method];if(typeof original!=='function')throw Error('Missing pool method '+method);PoolManager.prototype[method]=function(...args){const allocation=method==='getNewWorker'&&this.unusedWorkers.length===0;poolTotals[method==='getNewWorker'?'get':'returns']++;if(allocation)poolTotals.allocations++;const before=poolSnapshot(this);try{const result=Reflect.apply(original,this,args);poolTrace({method,phase:'return',allocation,worker:poolIdentity(method==='getNewWorker'?result:args[0]),before,after:poolSnapshot(this)});return result}catch(error){poolTotals.throws++;poolTrace({method,phase:'throw',allocation,before,after:poolSnapshot(this)});throw error}}}
const {t:cachedBinding}=await import(process.cwd()+'/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs');const lifecycleBinding=cachedBinding();let runtimeEvents=0;
for(const method of ['startAsyncRuntime','shutdownAsyncRuntime']){const original=lifecycleBinding[method];if(typeof original!=='function')throw Error('Missing runtime lifecycle export '+method);lifecycleBinding[method]=function(...args){const trace=phase=>{if(runtimeEvents++<32)console.log('COMPOSITION_RUNTIME '+JSON.stringify({method,phase,stage:evidence.stages.at(-1),hook:activeCompositionHook}))};trace('enter');try{const result=Reflect.apply(original,this,args);trace('return');return result}catch(error){trace('throw');throw error}}}
 const {transformSync}=await import('rolldown/utils');`)
    // Only mark the synchronous call responsible for allocating a worker.
    // Return the original thenable, with no extra promise observers.
    source=source.replace(" evidence.stages.push('imported');",`for(const item of [plugin,resolver,json])for(const method of ['load','transform']){const hook=item[method],original=typeof hook==='function'?hook:hook?.handler;if(!original)continue;const wrapped=function(...args){const previous=activeCompositionHook;activeCompositionHook={plugin:item.name,method,id:String(args[method==='transform'?1:0]).slice(0,200)};try{return Reflect.apply(original,this,args)}finally{activeCompositionHook=previous}};item[method]=typeof hook==='function'?wrapped:{...hook,handler:wrapped}}\n evidence.stages.push('imported');`)
  }
  if(traceImmediates){
    source=source.replace('const live=new Set();',`const live=new Set();
let immediateSequence=0,immediateCurrent=0,immediateEvents=0,immediateTraceEnabled=true;const immediateHandles=new Map(),pendingImmediateIds=new Set(),originalImmediate=globalThis.setImmediate,originalClearImmediate=globalThis.clearImmediate;
const immediateTotals={queued:0,begun:0,ended:0,cancelled:0,maxPending:0};
const immediateTrace=row=>{if(immediateTraceEnabled&&immediateEvents++<256)console.log('COMPOSITION_IMMEDIATE '+JSON.stringify({...row,stage:evidence.stages.at(-1)}))};
globalThis.setImmediate=function(callback,...args){const id=++immediateSequence,parent=immediateCurrent,stack=new Error().stack?.split('\\n');pendingImmediateIds.add(id);immediateTotals.queued++;immediateTotals.maxPending=Math.max(immediateTotals.maxPending,pendingImmediateIds.size);immediateTrace({phase:'queued',id,parent,pending:pendingImmediateIds.size,caller:stack?.slice(0,5).join(' ').slice(0,900),outerCaller:stack?.slice(-5).join(' ').slice(0,900)});const handle=originalImmediate(function(...values){pendingImmediateIds.delete(id);immediateHandles.delete(handle);immediateTotals.begun++;const previous=immediateCurrent;immediateCurrent=id;immediateTrace({phase:'begin',id,pending:pendingImmediateIds.size});try{return callback.apply(this,values)}finally{immediateTotals.ended++;immediateTrace({phase:'end',id,pending:pendingImmediateIds.size});immediateCurrent=previous}},...args);immediateHandles.set(handle,id);return handle};
globalThis.clearImmediate=function(handle){const result=originalClearImmediate(handle),id=immediateHandles.get(handle);if(id!==undefined){immediateHandles.delete(handle);pendingImmediateIds.delete(id);immediateTotals.cancelled++;immediateTrace({phase:'cancel',id,pending:pendingImmediateIds.size})}return result};
const immediateSummary=()=>{console.log('COMPOSITION_IMMEDIATE_TOTALS '+JSON.stringify({...immediateTotals,pending:pendingImmediateIds.size,detailEvents:immediateEvents,dropped:Math.max(0,immediateEvents-256)}));immediateTraceEnabled=false};`)
    source=source.replace('console.log(JSON.stringify(evidence));','immediateSummary();console.log(JSON.stringify(evidence));')
  }
  if(traceCallbacks){
    // The binding uses the public synchronous loader and overwriteImports hook.
    // Observe its existing callback without changing WebAssembly globally.
    source=source.replace("if(process.env.COUNT_NATIVE_WORKERS==='1')",`let callbackContext,activeImmediateCallback,callbackEvents=0,callbackImportInstalls=0,settlementEvents=0;const settlementImports=[];const callbackTrace=row=>{if(immediateTraceEnabled&&callbackEvents++<128)console.log('COMPOSITION_CALLBACK '+JSON.stringify({...row,stage:evidence.stages.at(-1),immediate:immediateCurrent}))};
const {createRequire}=await import('node:module'),callbackRequire=createRequire(import.meta.url),callbackRuntime=callbackRequire('@napi-rs/wasm-runtime'),originalInstantiate=callbackRuntime.instantiateNapiModuleSync;
callbackRuntime.instantiateNapiModuleSync=function(input,options){const originalOverwrite=options.overwriteImports;options.overwriteImports=function(...args){const imports=Reflect.apply(originalOverwrite,this,args),env=imports.env;const original=env._emnapi_set_immediate;if(typeof original!=='function')throw Error('Expected emnapi immediate import');callbackImportInstalls++;env._emnapi_set_immediate=function(callback,data){const previous=callbackContext;callbackContext={origin:'wasm-import',callback,data};callbackTrace(callbackContext);try{return Reflect.apply(original,this,arguments)}finally{callbackContext=previous}};for(const method of ['napi_resolve_deferred','napi_reject_deferred']){const original=env[method];settlementImports.push({method,present:typeof original==='function'});if(typeof original!=='function')continue;env[method]=function(envId,deferred,resolution){const log=row=>{if(immediateTraceEnabled&&settlementEvents++<128)console.log('COMPOSITION_SETTLEMENT '+JSON.stringify({method,envId,deferred,resolution,stage:evidence.stages.at(-1),immediate:immediateCurrent,active:activeImmediateCallback,hook:typeof activeCompositionHook==='undefined'?undefined:activeCompositionHook,...row}))};try{const status=Reflect.apply(original,this,arguments);log({phase:'return',status});return status}catch(error){log({phase:'throw'});throw error}}}return imports};try{return Reflect.apply(originalInstantiate,this,[input,options])}finally{options.overwriteImports=originalOverwrite}};
const {EventEmitter}=await import('node:events'),originalEmit=EventEmitter.prototype.emit;EventEmitter.prototype.emit=function(event,...args){const message=args[0]?.__emnapi__;if(event!=='message'||message?.type!=='async-send')return Reflect.apply(originalEmit,this,[event,...args]);const previous=callbackContext;callbackContext={origin:'async-send',type:message.payload?.type,callback:message.payload?.callback,data:message.payload?.data};callbackTrace(callbackContext);try{return Reflect.apply(originalEmit,this,[event,...args])}finally{callbackContext=previous}};
if(process.env.COUNT_NATIVE_WORKERS==='1')`)
    source=source.replace('const settlementImports=[];', 'const settlementImports=[],deferredOrigins=new Map();let deferredGeneration=0,creationEvents=0,creationDropped=0,creationReadErrors=0;')
    source=source.replace("for(const method of ['napi_resolve_deferred','napi_reject_deferred'])",`const originalCreate=env.napi_create_promise;settlementImports.push({method:'napi_create_promise',present:typeof originalCreate==='function'});if(typeof originalCreate==='function')env.napi_create_promise=function(envId,deferredPointer,promisePointer){const status=Reflect.apply(originalCreate,this,arguments);if(status===0){try{const pointer=deferredPointer>>>0,buffer=env.memory?.buffer;if(!Number.isInteger(deferredPointer)||!buffer||pointer>buffer.byteLength-4){creationReadErrors++}else{const deferred=new DataView(buffer).getUint32(pointer,true),origin={generation:++deferredGeneration,stage:evidence.stages.at(-1),immediate:immediateCurrent,active:activeImmediateCallback,hook:typeof activeCompositionHook==='undefined'?undefined:activeCompositionHook};if(deferredOrigins.size<128||deferredOrigins.has(deferred))deferredOrigins.set(deferred,origin);else creationDropped++;if(immediateTraceEnabled&&creationEvents++<256)console.log('COMPOSITION_DEFERRED '+JSON.stringify({envId,deferred,status,...origin}))}}catch{creationReadErrors++}}return status};for(const method of ['napi_resolve_deferred','napi_reject_deferred'])`)
    source=source.replace('const log=row=>{if(immediateTraceEnabled&&settlementEvents++<128)', 'const provenance=deferredOrigins.get(deferred);const log=row=>{if(immediateTraceEnabled&&settlementEvents++<128)')
    source=source.replace('{method,envId,deferred,resolution,stage:', '{method,envId,deferred,resolution,provenance,stage:')
    source=source.replace("log({phase:'return',status});return status", "log({phase:'return',status});if(status===0)deferredOrigins.delete(deferred);return status")
    source=source.replace("{phase:'queued',id,parent,pending:","{phase:'queued',id,parent,callbackContext,pending:")
    source=source.replace('parent=immediateCurrent,stack=', 'parent=immediateCurrent,scheduledCallback=callbackContext,stack=')
    source=source.replace('const previous=immediateCurrent;immediateCurrent=id;', 'const previous=immediateCurrent,previousActive=activeImmediateCallback;immediateCurrent=id;activeImmediateCallback={id,parent,...scheduledCallback};')
    source=source.replace('immediateCurrent=previous}},...args)', 'immediateCurrent=previous;activeImmediateCallback=previousActive}},...args)')
    source=source.replace('hook:activeCompositionHook,totals:', 'hook:activeCompositionHook,immediate:immediateCurrent,active:activeImmediateCallback,totals:')
    source=source.replace('stage:evidence.stages.at(-1),hook:activeCompositionHook}))', 'stage:evidence.stages.at(-1),hook:activeCompositionHook,immediate:immediateCurrent,active:activeImmediateCallback}))')
    source=source.replace('immediateSummary();console.log(JSON.stringify(evidence));',"console.log('COMPOSITION_CALLBACK_TOTALS '+JSON.stringify({events:callbackEvents,dropped:Math.max(0,callbackEvents-128),importInstalls:callbackImportInstalls,settlementEvents,settlementDropped:Math.max(0,settlementEvents-128),settlementImports,creationEvents,creationTraceDropped:Math.max(0,creationEvents-256),creationDropped,creationReadErrors,remainingDeferredOrigins:deferredOrigins.size}));immediateSummary();console.log(JSON.stringify(evidence));")
  }
  if(traceAwaits){
    // Log at existing continuation boundaries. Do not add awaits or attach
    // observers to the original promises, since those would change ordering.
    source=source.replace('try{\n const fs=',`let awaitEvents=0;const awaitTrace=row=>{if(awaitEvents++<128)console.log('COMPOSITION_AWAIT '+JSON.stringify({...row,stage:evidence.stages.at(-1),immediate:immediateCurrent}))};\ntry{\n const fs=`)
    const changes=[
      ["loads.push(value??null);", "awaitTrace({step:'load-resumed',index:i,plugin:item.name});loads.push(value??null);"],
      ["transforms.push(value??null);", "awaitTrace({step:'transform-resumed',index:i,plugin:item.name});transforms.push(value??null);"],
      ["moduleType:'js'}));if(typeof jsonResult", "moduleType:'js'}));awaitTrace({step:'json-resumed',index:i});if(typeof jsonResult"],
      ["evidence.stages.push('done-'+i);return {code:current", "awaitTrace({step:'pipeline-return',index:i});evidence.stages.push('done-'+i);return {code:current"],
    ]
    for(const [from,to] of changes){if(!source.includes(from))throw Error('Missing await trace insertion: '+from);source=source.replace(from,to)}
    source=source.replace('immediateSummary();console.log(JSON.stringify(evidence));',"console.log('COMPOSITION_AWAIT_TOTALS '+JSON.stringify({events:awaitEvents,dropped:Math.max(0,awaitEvents-128)}));immediateSummary();console.log(JSON.stringify(evidence));")
  }
  if(traceLifecycleImports){
    source=source.replace('const settlementImports=[],', 'let lifecycleImportEvents=0;const lifecycleImports=[];const settlementImports=[],')
    const marker='return imports};try{return Reflect.apply(originalInstantiate'
    if(!source.includes(marker))throw Error('Missing lifecycle import insertion')
    source=source.replace(marker,`for(const name of ['napi_delete_reference','napi_reference_unref','napi_release_threadsafe_function','napi_call_threadsafe_function','napi_delete_async_work','napi_close_handle_scope','napi_close_escapable_handle_scope','napi_remove_async_cleanup_hook']){const original=env[name];lifecycleImports.push({name,present:typeof original==='function'});if(typeof original!=='function')continue;env[name]=function(...args){const active=activeImmediateCallback,observe=active?.origin==='wasm-import';try{const status=Reflect.apply(original,this,args);if(observe&&lifecycleImportEvents++<128)console.log('COMPOSITION_LIFECYCLE_IMPORT '+JSON.stringify({name,status,active,stage:evidence.stages.at(-1),immediate:immediateCurrent}));return status}catch(error){if(observe&&lifecycleImportEvents++<128)console.log('COMPOSITION_LIFECYCLE_IMPORT '+JSON.stringify({name,threw:true,active,immediate:immediateCurrent}));throw error}}}return imports};try{return Reflect.apply(originalInstantiate`)
    source=source.replace('immediateSummary();console.log(JSON.stringify(evidence));',"console.log('COMPOSITION_LIFECYCLE_IMPORT_TOTALS '+JSON.stringify({events:lifecycleImportEvents,dropped:Math.max(0,lifecycleImportEvents-128),imports:lifecycleImports}));immediateSummary();console.log(JSON.stringify(evidence));")
  }
  const native=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:resolve('fixtures/vite-rolldown-wasm'),env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:nativeBinding,COUNT_NATIVE_WORKERS:'1'},encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message},null,2));await info.attach('native.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1));expect(expected.workers.peak).toBeLessThanOrEqual(6);expect(expected.workers.remaining).toBe(0);expect(expected.results).toHaveLength(mode==='microtask-interleaved'?6:3);
  if(mode.startsWith('scan-html-full-basic-serial-graph-')){expect(expected.prepared).toEqual(['main-0.ts','main-1.ts','main-2.ts']);expect(expected.stages.filter(stage=>stage!=='scan-done')).toEqual(['imported','scan-start','graph-start','graph-ready',...(mode.includes('-no-checkpoint-')?[]:['after-checkpoint']),'start-0','done-0','start-1','done-1','start-2','done-2']);expect(expected.stages.filter(stage=>stage==='scan-done')).toHaveLength(1);for(const result of expected.results){expect(result.code).not.toContain('import ');expect(result.code).not.toContain('import.meta.hot')}}
  if(mode.startsWith('scan-html-mixed-')){expect(expected.results.map(r=>r.resolved)).toEqual(['message.ts',null,null]);expect(expected.prepared).toEqual(['main.ts','client.mjs','env.mjs']);expect(expected.chain).toEqual({scanner:3,foreground:4,runtimeNull:7,pending:0});expect(expected.results[0].code).toContain('let count = 42;');expect(expected.results[1].code).toContain('WebSocket');expect(expected.results[2].code).toContain('globalThis');for(const result of expected.results){expect(result.errors).toEqual([]);expect(result.loads).toEqual([null,null,null]);expect(result.transforms).toEqual([null,null])}}
  else expect(expected.results.every(r=>r.resolved===(mode.startsWith('scan-html-full-basic-serial-')?null:'message.ts'))).toBe(true)
  if(mode.startsWith('build-'))expect(expected.build).toEqual({chunks:1,result:'first version:42'})
  if(mode.startsWith('scan-html-'))expect(expected.scan).toEqual({visited:['entry.ts','index.html','message.ts'],resolved:['entry.ts','index.html','message.ts'],extractedSource:'import "./entry.ts"; export default {}'})
  if(mode.startsWith('scan-html-chain-')||mode.startsWith('scan-html-full-'))expect(expected.chain).toEqual({scanner:3,foreground:mode==='scan-html-full-basic-serial-with-scan'?0:3,runtimeNull:mode==='scan-html-full-basic-serial-with-scan'?3:6,pending:0})
  if(mode==='runtime-shutdown-pending-transform'){expect(expected.overlap).toBeNull();expect(expected.chain).toEqual({scanner:0,foreground:3,runtimeNull:3,pending:0});expect(expected.stages.slice(0,5)).toEqual(['imported','runtime-start','transform-invoked','runtime-shutdown','transform-awaited'])}
  if(mode.startsWith('scan-html-full-')||mode==='runtime-shutdown-pending-transform')for(const result of expected.results){expect(result.loads).toEqual([null,null,null]);expect(result.transforms).toEqual([null,null]);expect(result.jsonTransform).toBeNull();expect(result.errors).toEqual([]);expect(result.code).toContain('let count = 42;')}
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async({source,policy,guestBinding,mixed,diagnostics})=>{
    const snapshot=await fetch(mixed?'/mixed-fixture.json':'/fixture.json').then(r=>r.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
    files['/project/main.mjs']=source
    const kernel=new window.sdk.WorkerKernel(files,policy);let result,error,jobProfile
    try{result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:guestBinding},guestWasm:true,webAPIs:true,diagnostics,maxBytes:policy.maxBytes,timeoutMs:15000})}catch(e){error={name:e.name,message:e.message}}
    finally{jobProfile=kernel.jobProfile.slice(0,100);kernel.close()}
    return {result,error,diagnostics,jobProfile,workerLifecycle:kernel.workerLifecycle,hostTaskScheduling:kernel.hostTaskScheduling}
  },{source,policy,guestBinding,mixed:mode.startsWith('scan-html-mixed-'),diagnostics})
  const path=info.outputPath('guest.json');await writeFile(path,JSON.stringify({root,policy,preparation,expected,observed},null,2));await info.attach('guest.json',{path,contentType:'application/json'})
  if(diagnostics){
    expect(observed.hostTaskScheduling.length).toBeGreaterThan(0)
    expect(observed.hostTaskScheduling.length).toBeLessThanOrEqual(32)
    for(const trace of observed.hostTaskScheduling){
      expect(trace.hostTasks.length).toBeLessThanOrEqual(64)
      expect(trace.count).toBe(trace.dropped+trace.hostTasks.length)
      for(const sample of trace.hostTasks)if(sample.phase==='dispatch')expect(sample.dispatchAt).toBeGreaterThanOrEqual(sample.postedAt)
    }
  }
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  const actual=JSON.parse(observed.result.stdout.trim().split('\n').at(-1))
  expect(actual.failure).toBeUndefined();expect(actual.results).toEqual(expected.results)
  if(mode.startsWith('scan-html-full-basic-serial-graph-')){expect(actual.prepared).toEqual(expected.prepared);expect(actual.stages.filter(stage=>stage!=='scan-done')).toEqual(expected.stages.filter(stage=>stage!=='scan-done'));expect(actual.stages.filter(stage=>stage==='scan-done')).toHaveLength(1)}
  if(mode==='scan-html-full-basic-serial-with-scan')for(const evidence of [expected,actual]){expect(evidence.stages.filter(stage=>/^(start|done)-/.test(stage))).toEqual(['start-0','done-0','start-1','done-1','start-2','done-2']);expect(evidence.stages.indexOf('scan-start')).toBeLessThan(evidence.stages.indexOf('start-0'));expect(evidence.stages.filter(stage=>stage==='scan-done')).toHaveLength(1);expect(evidence.stages.indexOf('scan-done')).toBeGreaterThan(evidence.stages.indexOf('start-0'));for(const result of evidence.results){expect(result.code).not.toContain('import ');expect(result.code).not.toContain('import.meta.hot');expect(result.resolved).toBeNull()}}
  if(mode.startsWith('build-'))expect(actual.build).toEqual(expected.build)
  if(mode.startsWith('scan-html-'))expect(actual.scan).toEqual(expected.scan)
  if(mode.startsWith('scan-html-chain-')||mode.startsWith('scan-html-full-'))expect(actual.chain).toEqual(expected.chain)
  if(mode.startsWith('scan-html-mixed-')){expect(actual.chain).toEqual(expected.chain);expect(actual.prepared).toEqual(expected.prepared)}
  if(mode==='runtime-shutdown-pending-transform'){expect(actual.overlap).toEqual(expected.overlap);expect(actual.chain).toEqual(expected.chain);expect(actual.stages).toEqual(expected.stages)}
})
