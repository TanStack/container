import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {AsyncLocalStorage,AsyncResource} from 'node:async_hooks'
import {Worker} from 'node:worker_threads'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fs as constructors} from 'memfs'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'
import {createWasiFilesystemClient} from '../src/native/wasi-fs-transport.mjs'
import {createWasiFilesystemEndpoint} from '../src/native/wasi-filesystem-service.mjs'
import {createNativeFilesystemWatchClient} from '../src/native/filesystem-watch-client.mjs'

const require=createRequire(import.meta.url),runtime=dirname(require.resolve('@napi-rs/wasm-runtime'))
assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'))).version,'1.2.4')
const source=replaceWasiFsProxy(readFileSync(join(runtime,'fs-proxy.js'),'utf8'),
  new URL('../src/native/wasi-fs-transport.mjs',import.meta.url).href)+'\nexport {decodeValue};'
const codecURL='data:text/javascript;base64,'+Buffer.from(source).toString('base64'),codec=await import(codecURL)

async function fixture(fn,serviceOptions){
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {createNativeFilesystemBackend}=await import(workerData.backendURL),{fs}=createNativeFilesystemBackend();
      const {createWasiFilesystemService}=await import(workerData.serviceURL),codec=await import(workerData.codecURL);
      fs.mkdirSync('/app/nested',{recursive:true});fs.writeFileSync('/app/file','before');fs.writeFileSync('/app/nested/file','nested');
      const watching=[],originalWatch=fs.watch;
      fs.watch=(...args)=>{const watcher=originalWatch(...args);watching.push(watcher);return watcher};
      const service=createWasiFilesystemService(fs,codec.createOnMessage,workerData.serviceOptions);
      parentPort.on('message',data=>{
        if(data.type==='inspect')parentPort.postMessage({type:'inspect',...service.inspect(),...service.inspectWatchers()});
        else if(data.type==='watch-error')watching.at(-1).emit('error',Object.assign(new Error('Original watch error'),{code:'EIO',path:'/app/file',syscall:'watch'}));
        else service.onMessage({data});
      });
      parentPort.postMessage({type:'ready'});
    })().catch(error=>{throw error});
  `,{eval:true,workerData:{codecURL,serviceOptions,
    backendURL:process.env.NATIVE_FILESYSTEM_BACKEND_URL??new URL('../src/native/filesystem-backend.mjs',import.meta.url).href,
    serviceURL:new URL('../src/native/wasi-filesystem-service.mjs',import.meta.url).href}})
  const connections=[]
  try{
    assert.deepEqual((await once(worker,'message',{signal:AbortSignal.timeout(5000)}))[0],{type:'ready'})
    function connect(id,options){
      const endpoint=createWasiFilesystemEndpoint(worker,id)
      const fs=createWasiFilesystemClient(constructors,{decodeValue:codec.decodeValue,timeoutMs:2000,
        send:message=>endpoint.port.postMessage(message)})
      const client=createNativeFilesystemWatchClient(fs,endpoint.port,options)
      const connection={fs,client,endpoint};connections.push(connection);return connection
    }
    async function inspect(){
      const response=once(worker,'message',{signal:AbortSignal.timeout(3000)})
      worker.postMessage({type:'inspect'});return (await response)[0]
    }
    await fn({connect,inspect,worker})
  }finally{
    for(const {client,endpoint} of connections){client.dispose();endpoint.dispose()}
    await worker.terminate()
  }
}
const settings={timeout:10000}
const nextChange=watcher=>once(watcher,'change',{signal:AbortSignal.timeout(3000)})
const nextClose=watcher=>once(watcher,'close',{signal:AbortSignal.timeout(3000)})

test('a real service delivers a callback and recursive change from a different client',settings,()=>fixture(async({connect,inspect})=>{
  const reader=connect('reader'),writer=connect('writer'),callbacks=[]
  const watcher=reader.client.watch('/app',{recursive:true},(...args)=>callbacks.push(args))
  assert.ok(watcher instanceof reader.client.FSWatcher)
  const event=nextChange(watcher)
  writer.fs.writeFileSync('/app/nested/file','changed')
  assert.deepEqual(await event,['change','nested/file'])
  assert.deepEqual(callbacks[0],['change','nested/file'])
  assert.equal(reader.fs.readFileSync('/app/nested/file','utf8'),'changed')
  assert.equal((await inspect()).watches,1)
}))

test('buffer filename encoding is restored after structured cloning',settings,()=>fixture(async({connect})=>{
  const {fs,client}=connect('buffer'),watcher=client.watch('/app',{encoding:'buffer'})
  const event=nextChange(watcher);fs.writeFileSync('/app/file','changed')
  const [change,filename]=await event
  assert.equal(change,'change');assert.ok(Buffer.isBuffer(filename));assert.equal(filename.toString(),'file')
}))

test('closing twice removes the remote watcher once and ignores queued changes',settings,()=>fixture(async({connect,inspect})=>{
  const {fs,client}=connect('close'),watcher=client.watch('/app/file'),events=[]
  watcher.on('change',(...args)=>events.push(args))
  let closes=0;watcher.on('close',()=>closes++)
  fs.writeFileSync('/app/file','queued before close')
  const closed=nextClose(watcher);watcher.close();watcher.close();await closed
  fs.statSync('/app/file') // A same-port barrier confirms the host processed close.
  assert.equal((await inspect()).watches,0)
  assert.equal(closes,1);assert.deepEqual(events,[])
  assert.deepEqual(client.inspect(),{disposed:false,watches:0})
}))

test('aborting an active or already-aborted watch drains both sides',settings,()=>fixture(async({connect,inspect})=>{
  const {fs,client}=connect('abort'),controller=new AbortController()
  const watcher=client.watch('/app/file',{signal:controller.signal}),closed=nextClose(watcher)
  controller.abort();await closed;fs.statSync('/app/file')
  assert.equal((await inspect()).watches,0)
  const already=client.watch('/app/file',{signal:controller.signal})
  await nextClose(already);fs.statSync('/app/file')
  assert.equal((await inspect()).watches,0)
}))

test('endpoint disposal closes only that endpoint watchers',settings,()=>fixture(async({connect,inspect})=>{
  const first=connect('first'),second=connect('second')
  first.client.watch('/app/file');const remaining=second.client.watch('/app/file')
  assert.equal((await inspect()).watches,2)
  first.client.dispose();first.endpoint.dispose()
  assert.equal((await inspect()).watches,1)
  const event=nextChange(remaining);second.fs.writeFileSync('/app/file','still live')
  assert.equal((await event)[0],'change')
}))

test('failed watch creation and invalid options do not retain a local or remote handle',settings,()=>fixture(async({connect,inspect})=>{
  const {client}=connect('invalid')
  assert.throws(()=>client.watch('/missing'),error=>error.code==='ENOENT')
  assert.throws(()=>client.watch('/app/file',{signal:{}}),TypeError)
  assert.throws(()=>client.watch('/app/file',{},'not a callback'),TypeError)
  assert.throws(()=>client.watch('/app/file',{encoding:'not an encoding'}),TypeError)
  assert.deepEqual(client.inspect(),{disposed:false,watches:0})
  assert.equal((await inspect()).watches,0)
}))

test('ref and unref track caller activity without retaining it after close',settings,()=>fixture(async({connect})=>{
  let active=0
  const {client}=connect('ref',{keepAlive:()=>{active++;return ()=>active--}})
  const watcher=client.watch('/app/file',{persistent:false})
  assert.equal(active,0);assert.equal(watcher.ref(),watcher);assert.equal(watcher.ref(),watcher);assert.equal(active,1)
  assert.equal(watcher.unref(),watcher);assert.equal(watcher.unref(),watcher);assert.equal(active,0)
  watcher.ref();assert.equal(active,1);watcher.close();assert.equal(active,0)
  assert.equal(watcher.ref(),watcher);assert.equal(active,0)
}))

test('change listeners run in the creation context when the runtime supplies an async resource',settings,()=>fixture(async({connect})=>{
  const context=new AsyncLocalStorage(),{fs,client}=connect('context',{createAsyncResource:name=>new AsyncResource(name)})
  let watcher,observed
  context.run('watch-owner',()=>{watcher=client.watch('/app/file',()=>{observed=context.getStore()})})
  const event=nextChange(watcher)
  context.run('writer',()=>fs.writeFileSync('/app/file','changed'))
  await event;assert.equal(observed,'watch-owner')
}))

test('disposing the watcher client leaves the shared endpoint available for ordinary file calls',settings,()=>fixture(async({connect,inspect})=>{
  const {fs,client}=connect('dispose'),watcher=client.watch('/app/file'),closed=nextClose(watcher)
  client.dispose();client.dispose();await closed
  fs.writeFileSync('/app/file','after disposal')
  assert.equal(fs.readFileSync('/app/file','utf8'),'after disposal')
  assert.equal((await inspect()).watches,0)
  assert.throws(()=>client.watch('/app/file'),/disposed/)
}))

test('the caller lifecycle signal disposes all watches without closing its file endpoint',settings,()=>fixture(async({connect,inspect})=>{
  const controller=new AbortController(),{fs,client}=connect('lifecycle',{signal:controller.signal})
  const first=client.watch('/app/file'),second=client.watch('/app/nested',{recursive:true})
  const closes=[nextClose(first),nextClose(second)]
  controller.abort();await Promise.all(closes)
  fs.statSync('/app/file');assert.equal((await inspect()).watches,0)
  assert.deepEqual(client.inspect(),{disposed:true,watches:0})
}))

test('a backend watch error retains its details and closes the remote resource',settings,()=>fixture(async({connect,inspect,worker})=>{
  const {fs,client}=connect('error'),watcher=client.watch('/app/file')
  const error=new Promise(resolve=>watcher.once('error',resolve))
  const closed=new Promise(resolve=>watcher.once('close',resolve))
  worker.postMessage({type:'watch-error'})
  const received=await error;await closed
  assert.equal(received.message,'Original watch error');assert.equal(received.code,'EIO')
  assert.equal(received.path,'/app/file');assert.equal(received.syscall,'watch')
  fs.statSync('/app/file');assert.equal((await inspect()).watches,0)
  assert.deepEqual(client.inspect(),{disposed:false,watches:0})
}))

test('a synchronous burst coalesces repeated same-file changes with one notification in flight',settings,()=>fixture(async({connect,inspect})=>{
  const {fs,client}=connect('burst'),watcher=client.watch('/app/file'),events=[]
  watcher.on('change',(...args)=>events.push(args))
  const first=nextChange(watcher)
  for(let index=0;index<1000;index++)fs.writeFileSync('/app/file','value '+index)
  await first;await nextChange(watcher)
  fs.statSync('/app/file')
  const state=await inspect()
  assert.equal(events.length,2);assert.equal(state.pendingEvents,0);assert.equal(state.inFlightEvents,0)
  assert.equal(fs.readFileSync('/app/file','utf8'),'value 999')
}))

test('distinct-path overflow reports ENOSPC instead of silently losing changes',settings,()=>fixture(async({connect,inspect})=>{
  const {fs,client}=connect('overflow'),watcher=client.watch('/app',{recursive:true})
  const error=new Promise(resolve=>watcher.once('error',resolve))
  const closed=new Promise(resolve=>watcher.once('close',resolve))
  for(let index=0;index<10;index++)fs.writeFileSync('/app/new-'+index,'written')
  const received=await error;await closed
  assert.equal(received.code,'ENOSPC');assert.equal(received.syscall,'watch')
  fs.statSync('/app/file')
  const state=await inspect()
  assert.equal(state.watches,0);assert.equal(state.pendingEvents,0);assert.equal(state.inFlightEvents,0)
  assert.equal(fs.readFileSync('/app/new-9','utf8'),'written')
},{maxPendingWatchEvents:2}))
