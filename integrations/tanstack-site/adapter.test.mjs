import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

const require=createRequire(import.meta.url)
const {build}=require('esbuild')
const adapter=process.env.TANSTACK_SITE_ADAPTER ?? fileURLToPath(new URL('../../../tanstack.com/src/utils/example-sdk.client.ts',import.meta.url))
const symbol='tanstack-local-sdk-adapter-test'
const bundled=await build({entryPoints:[adapter],bundle:true,write:false,platform:'browser',format:'esm',plugins:[{
  name:'mock-sdk',setup(builder){
    builder.onResolve({filter:/^@tanstack\/browser-sandbox-experimental$/},()=>({path:'sdk',namespace:'mock-sdk'}))
    builder.onLoad({filter:/.*/,namespace:'mock-sdk'},()=>({contents:`const sdk=globalThis[Symbol.for(${JSON.stringify(symbol)})];export const {WorkerKernel,WorkerHTTP,WorkerWebSocket,URLPreview,assertSDKRuntimeEnvironment,installProjectCommand,spawnProjectCommand}=sdk;`,loader:'js'}))
  },
}]})
let nextModule=0
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const ticks=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
async function until(check){for(let i=0;i<100;i++){if(check())return;await Promise.resolve()}assert.fail('Expected adapter milestone was not reached')}

async function setup(t,{autoReady=true,checkpointKey='project:test',resume=false,fail={}}={}){
  const globals=new Map(['crossOriginIsolated','location','fetch'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]))
  const state={events:[],output:[],statuses:[],fetches:0,kernels:[],mounts:[],mount:deferred(),shutdown:deferred(),exit:deferred(),reads:[],queued:[],previewClosed:false,spawned:false,installs:0,saves:[],restores:[],metadata:{key:'project:test',byteLength:4096,savedAt:1234},fileText:'restored source'}
  const child={
    next(){if(state.queued.length)return Promise.resolve(state.queued.shift());const pending=deferred();state.reads.push(pending);return pending.promise},
    wait(){return state.exit.promise},
    async dispose(){state.events.push('child.dispose');if(fail.dispose)throw fail.dispose;state.event(null)},
  }
  state.event=value=>{const pending=state.reads.shift();if(pending)pending.resolve(value);else state.queued.push(value)}
  state.port=(port,type='open')=>{for(const kernel of state.kernels)for(const callback of kernel.listeners)callback({type,port})}
  state.stdout=text=>state.event({type:'stdout',bytes:new TextEncoder().encode(text)})
  const preview={close(){if(state.previewClosed)return;state.previewClosed=true;state.events.push('preview.close')}}
  state.preview=preview
  class WorkerKernel{
    constructor(files,options){this.files=files;this.options=options;this.listeners=new Set();state.kernels.push(this);state.events.push('kernel.create')}
    async install(){state.installs++;state.events.push('install');if(fail.install)throw fail.install;return {installed:4}}
    async saveCheckpoint(key){state.saves.push(key);state.events.push('saveCheckpoint');if(fail.saveCheckpoint)throw fail.saveCheckpoint;return state.metadata}
    async restoreCheckpoint(key){state.restores.push(key);state.events.push('restoreCheckpoint');if(fail.restoreCheckpoint)throw fail.restoreCheckpoint;return state.metadata}
    async checkpointMetadata(key){state.events.push(['checkpointMetadata',key]);return key===state.metadata.key?state.metadata:undefined}
    async deleteCheckpoint(key){state.events.push(['deleteCheckpoint',key]);return key===state.metadata.key}
    async readText(path){state.events.push(['read',path]);if(fail.read)throw fail.read;return state.fileText}
    subscribePorts(callback){this.listeners.add(callback);return ()=>this.listeners.delete(callback)}
    async spawn(...args){state.spawned=true;state.spawnOptions=args.at(-1);if(autoReady){state.port(12345);state.port(49152);state.stdout('ready in 1ms\n')}return child}
    async writeText(path,text){state.events.push(['write',path,text])}
    close(){if(this.closed)return;this.closed=true;state.events.push('kernel.close');this.shutdown=state.shutdown.promise;state.event(null)}
  }
  globalThis[Symbol.for(symbol)]={WorkerKernel,WorkerHTTP:class{constructor(kernel,port){this.kernel=kernel;this.port=port}async fetch(){return {status:200,body:{async cancel(){}}}}},WorkerWebSocket:{connect(){throw Error('Not used by lifecycle tests')}},URLPreview:{mount(container,options){state.mounts.push({container,options});state.events.push('mount');return state.mount.promise}},assertSDKRuntimeEnvironment(){},installProjectCommand(kernel,command,options){return kernel.install(command,options)},spawnProjectCommand(kernel,command,options){return kernel.spawn(command,[],options)}}
  Object.defineProperty(globalThis,'crossOriginIsolated',{configurable:true,value:true})
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost:4198/'}})
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async url=>{state.fetches++;assert.equal(url,'/__sandbox-local/config.json');return {ok:true,json:async()=>({previewOrigin:'http://localhost:4199',appPort:49152,env:{},runtimeProfile:{kernelOptions:{}}})}}})
  t.after(()=>{
    state.shutdown.resolve();state.mount.resolve(preview);state.exit.resolve({exitCode:0});state.event(null)
    for(const [name,descriptor] of globals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name]}
    delete globalThis[Symbol.for(symbol)]
  })
  const source=bundled.outputFiles[0].text+`\n// test module ${nextModule++}`
  const {createSDKExampleSession}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
  const session=createSDKExampleSession({container:{},files:{'/project/main.js':'original'},checkpointKey,resume,onOutput:value=>state.output.push(value),onStatus:value=>{state.statuses.push(value);state.events.push('status:'+value)}})
  return {session,state}
}

test('dispose before start allocates no runtime and rejects later operations',async t=>{
  const {session,state}=await setup(t)
  const first=session.dispose(),second=session.dispose();await Promise.all([first,second])
  await assert.rejects(session.start(),/Session stopped/)
  await assert.rejects(session.writeFile('/project/main.js','changed'),/Session stopped/)
  assert.equal(state.fetches,0);assert.equal(state.kernels.length,0)
  assert.deepEqual(state.statuses,['Stopped'])
})

test('dispose during pending mount waits for both preview cleanup and kernel shutdown',async t=>{
  const {session,state}=await setup(t)
  const starting=session.start(),rejected=assert.rejects(starting,/Session stopped/)
  await until(()=>state.mounts.length===1)
  assert.equal(state.mounts[0].options.server.port,49152)
  const stopping=session.dispose(),alsoStopping=session.dispose()
  let stopped=false;void stopping.then(()=>{stopped=true})
  await ticks();assert.equal(stopped,false);assert.equal(state.previewClosed,false)
  state.mount.resolve(state.preview)
  await ticks();assert.equal(state.previewClosed,true);assert.equal(stopped,false)
  state.shutdown.resolve()
  await Promise.all([stopping,alsoStopping]);await rejected
  assert.equal(stopped,true)
  assert.equal(state.statuses.at(-1),'Stopped')
  assert.equal(state.statuses.includes('Preview attached'),false)
  assert.ok(state.events.indexOf('preview.close')<state.events.indexOf('status:Stopped'))
  await assert.rejects(session.writeFile('/project/main.js','changed'),/Session stopped/)
})

test('dispose during failed mount releases without replacing its startup error',async t=>{
  const {session,state}=await setup(t)
  const starting=session.start(),failure=Error('Preview bootstrap failed'),rejected=assert.rejects(starting,error=>error===failure)
  await until(()=>state.mounts.length===1)
  const stopping=session.dispose()
  state.mount.reject(failure);state.shutdown.resolve()
  await stopping;await rejected
  assert.equal(state.statuses.at(-1),'Stopped')
})

test('normal site sessions retain aggregate diagnostics without enabling the fine-grained job profiler',async t=>{
  const {session,state}=await setup(t)
  const starting=session.start();await until(()=>state.mounts.length===1)
  assert.equal(state.spawnOptions.diagnostics,true)
  assert.equal(state.spawnOptions.profileJobs,undefined)
  state.mount.resolve(state.preview);await starting
  state.shutdown.resolve();await session.dispose()
})

for(const exitCode of [0,7])test(`guest exit ${exitCode} after mount closes preview and runtime`,async t=>{
  const {session,state}=await setup(t)
  const starting=session.start()
  await until(()=>state.mounts.length===1)
  state.mount.resolve(state.preview);await starting
  assert.equal(state.statuses.at(-1),'Preview attached')
  state.exit.resolve({exitCode});state.event({type:'exit',code:exitCode,signal:null})
  await until(()=>state.previewClosed)
  await until(()=>state.kernels[0].closed)
  assert.equal(state.kernels[0].closed,true)
  assert.ok(state.output.includes(`App exited with status ${exitCode}\n`))
  assert.notEqual(state.statuses.at(-1),'Stopped')
  state.shutdown.resolve();await session.dispose()
  assert.equal(state.statuses.at(-1),'Stopped')
})

test('expected user disposal does not log a later guest exit as a failure',async t=>{
  const {session,state}=await setup(t)
  const starting=session.start();await until(()=>state.mounts.length===1)
  state.mount.resolve(state.preview);await starting
  const stopping=session.dispose();state.exit.resolve({exitCode:null,signal:'SIGKILL'});state.shutdown.resolve()
  await stopping;await ticks()
  assert.equal(state.output.some(value=>value.includes('App exited')),false)
  assert.equal(state.statuses.filter(value=>value==='Stopped').length,1)
})

test('save drains the child before committing its worker-owned checkpoint',async t=>{
  const {session,state}=await setup(t)
  const starting=session.start();await until(()=>state.mounts.length===1)
  state.mount.resolve(state.preview);await starting
  const saving=session.save()
  await until(()=>state.events.includes('kernel.close'))
  assert.equal(state.previewClosed,true)
  const childDispose=state.events.indexOf('child.dispose')
  const checkpoint=state.events.indexOf('saveCheckpoint')
  const kernelClose=state.events.indexOf('kernel.close')
  assert.ok(childDispose>=0)
  assert.ok(childDispose<checkpoint)
  assert.ok(checkpoint<kernelClose)
  assert.deepEqual(state.saves,['project:test'])
  assert.notEqual(state.statuses.at(-1),'Stopped')
  state.shutdown.resolve()
  assert.equal(await saving,state.metadata)
  assert.equal(state.statuses.at(-1),'Stopped')
  await assert.rejects(session.readFile('/project/main.js'),/Session stopped/)
  state.exit.resolve({exitCode:null,signal:'SIGKILL'});await ticks()
  assert.equal(state.output.some(value=>value.includes('App exited')),false)
})

test('restore starts from an empty kernel, skips install, and loads the worker-owned checkpoint by key',async t=>{
  const {session,state}=await setup(t,{checkpointKey:'project:test',resume:true})
  const starting=session.start();await until(()=>state.mounts.length===1)
  state.mount.resolve(state.preview);await starting
  assert.deepEqual(state.kernels[0].files,{})
  assert.deepEqual(state.restores,['project:test'])
  assert.equal(state.installs,0)
  assert.deepEqual(state.statuses.slice(0,3),['Restoring workspace','Starting app','Preview attached'])
  assert.ok(state.output.includes('Restored saved workspace without installing dependencies.\n'))
  assert.equal(await session.readFile('/project/main.js'),'restored source')
  assert.deepEqual(state.events.find(event=>Array.isArray(event)&&event[0]==='read'),['read','/project/main.js'])
  state.shutdown.resolve();await session.dispose()
})

test('checkpoint restore failure skips install, closes the kernel, and preserves the cause',async t=>{
  const failure=Error('Checkpoint is incompatible')
  const {session,state}=await setup(t,{checkpointKey:'project:bad',resume:true,fail:{restoreCheckpoint:failure}})
  const starting=session.start()
  await until(()=>state.kernels[0]?.closed)
  assert.equal(state.installs,0)
  assert.deepEqual(state.restores,['project:bad'])
  state.shutdown.resolve()
  await assert.rejects(starting,error=>error===failure)
  assert.equal(state.statuses.at(-1),'Stopped')
  assert.ok(state.output.includes('Startup failed: Error: Checkpoint is incompatible\n'))
})

test('read failures propagate without stopping a healthy session',async t=>{
  const failure=Error('Workspace read failed')
  const {session,state}=await setup(t,{fail:{read:failure}})
  await assert.rejects(session.readFile('/project/main.js'),/Start the app before reading files/)
  const starting=session.start();await until(()=>state.mounts.length===1)
  state.mount.resolve(state.preview);await starting
  await assert.rejects(session.readFile('/project/main.js'),error=>error===failure)
  assert.equal(state.kernels[0].closed,undefined)
  await assert.rejects(session.readFile('../secret'),/Invalid project path/)
  state.shutdown.resolve();await session.dispose()
})

test('checkpoint save failure still closes the kernel and reports the original failure',async t=>{
  const failure=Error('Checkpoint commit failed')
  const {session,state}=await setup(t,{fail:{saveCheckpoint:failure}})
  const starting=session.start();await until(()=>state.mounts.length===1)
  state.mount.resolve(state.preview);await starting
  const saving=session.save()
  await until(()=>state.kernels[0].closed)
  state.shutdown.resolve()
  await assert.rejects(saving,error=>error===failure)
  assert.equal(state.kernels[0].closed,true)
  assert.equal(state.statuses.at(-1),'Stopped')
})

test('saving without a checkpoint key rejects and still releases the runtime',async t=>{
  const {session,state}=await setup(t,{checkpointKey:null})
  const starting=session.start();await until(()=>state.mounts.length===1)
  state.mount.resolve(state.preview);await starting
  const saving=session.save()
  await until(()=>state.kernels[0].closed)
  state.shutdown.resolve()
  await assert.rejects(saving,/A checkpoint key is required/)
  assert.deepEqual(state.saves,[])
  assert.equal(state.statuses.at(-1),'Stopped')
})

test('resuming without a checkpoint key rejects before install, spawn, or mount',async t=>{
  const {session,state}=await setup(t,{checkpointKey:null,resume:true})
  const starting=session.start()
  await until(()=>state.kernels[0]?.closed)
  state.shutdown.resolve()
  await assert.rejects(starting,/A checkpoint key is required/)
  assert.equal(state.installs,0)
  assert.deepEqual(state.restores,[])
  assert.equal(state.spawned,false)
  assert.equal(state.mounts.length,0)
  assert.equal(state.statuses.at(-1),'Stopped')
})

test('neither unrelated nor matching ports mount before the complete Vite readiness line',async t=>{
  const {session,state}=await setup(t,{autoReady:false})
  const starting=session.start()
  await until(()=>state.spawned)
  state.port(12345);await ticks()
  assert.equal(state.mounts.length,0)
  state.port(49152);await ticks()
  assert.equal(state.mounts.length,0)
  state.stdout('Starting app\nready ');await ticks()
  assert.equal(state.mounts.length,0)
  state.stdout('in 1ms\n')
  await until(()=>state.mounts.length===1)
  assert.equal(state.mounts[0].options.server.port,49152)
  state.mount.resolve(state.preview);await starting
  assert.equal(state.statuses.at(-1),'Preview attached')
  state.shutdown.resolve();await session.dispose()
})

test('the Vite readiness line with an unrelated port still waits for the configured port',async t=>{
  const {session,state}=await setup(t,{autoReady:false})
  const starting=session.start()
  await until(()=>state.spawned)
  state.port(12345);state.stdout('ready in 1ms\n');await ticks()
  assert.equal(state.mounts.length,0)
  state.port(49152,'close');await ticks()
  assert.equal(state.mounts.length,0)
  state.port(49152)
  await until(()=>state.mounts.length===1)
  assert.equal(state.mounts[0].options.server.port,49152)
  state.mount.resolve(state.preview);await starting
  state.shutdown.resolve();await session.dispose()
})

test('guest exit after its port opens but before Vite readiness rejects without mounting',async t=>{
  const {session,state}=await setup(t,{autoReady:false})
  const starting=session.start(),rejected=assert.rejects(starting,/App exited before becoming ready/)
  await until(()=>state.spawned)
  state.port(49152);state.stdout('ready ');await ticks()
  assert.equal(state.mounts.length,0)
  state.event({type:'exit',code:7,signal:null});state.exit.resolve({exitCode:7})
  await until(()=>state.kernels[0].closed)
  state.shutdown.resolve();await rejected
  assert.equal(state.mounts.length,0)
  assert.equal(state.statuses.includes('Preview attached'),false)
  assert.equal(state.statuses.at(-1),'Stopped')
  assert.equal(state.kernels[0].listeners.size,0)
})
