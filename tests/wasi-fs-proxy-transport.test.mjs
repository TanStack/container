import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {memfs} from 'memfs'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'
import {createWasiFilesystemClient,createWasiFilesystemHost,manageWasiFilesystemWorker} from '../src/native/wasi-fs-transport.mjs'

const require=createRequire(import.meta.url),root=dirname(require.resolve('@napi-rs/wasm-runtime'))
assert.equal(JSON.parse(readFileSync(join(root,'package.json'))).version,'1.2.4')
const source=readFileSync(join(root,'fs-proxy.js'),'utf8')
const transport=pathToFileURL(join(process.cwd(),'src/native/wasi-fs-transport.mjs')).href
const patched=await import('data:text/javascript;base64,'+Buffer.from(replaceWasiFsProxy(source,transport)).toString('base64'))
const lane=()=>{const value=new Int32Array(new SharedArrayBuffer(16+10240));value[0]=21;return value}

function fixture(){
  const {fs}=memfs(),host=patched.createOnMessage(fs),messages=[]
  const proxy=createWasiFilesystemClient({}, {decodeValue:(_fs,bytes,type)=>{
    // Decode through the unchanged upstream client factory by intercepting only
    // its already-completed wire reply. Normal tests below use its actual codec.
    return {bytes:bytes.slice(),type}
  },send:message=>{messages.push(message);host({data:message})}})
  return {fs,host,proxy,messages}
}
function withRealClient(fs,fn){
  const host=patched.createOnMessage(fs),send=globalThis.postMessage,calls=[]
  globalThis.postMessage=message=>{calls.push(message);host({data:message})}
  try{return fn(patched.createFsProxy(fs),host,calls)}
  finally{if(send===undefined)delete globalThis.postMessage;else globalThis.postMessage=send;host.dispose()}
}

test('real upstream codecs preserve binary and string replies over every chunk boundary',()=>{
  const {fs}=memfs()
  for(const bytes of [0,1,10239,10240,10241,20480,20481,1024*1024]){
    const value=Buffer.alloc(bytes,71);fs.writeFileSync('/file',value)
    withRealClient(fs,(proxy,host,calls)=>{
      assert.deepEqual(proxy.readFileSync('/file'),value)
      assert.equal(host.inspect().pendingBytes,0)
      assert.equal(calls.filter(m=>m.__fs__.continue===true).length,Math.max(0,Math.ceil(bytes/10240)-1))
    })
  }
  const text='🍊abc'.repeat(5000);fs.writeFileSync('/text',text)
  withRealClient(fs,proxy=>assert.equal(proxy.readFileSync('/text','utf8'),text))
})

test('large directory replies, bigint stats and original filesystem errors retain their values',()=>{
  const {fs}=memfs();fs.mkdirSync('/many')
  for(let index=0;index<1200;index++)fs.writeFileSync('/many/file-'+String(index).padStart(5,'0'),'x')
  withRealClient(fs,proxy=>{
    assert.deepEqual(proxy.readdirSync('/many'),fs.readdirSync('/many'))
    const stat=proxy.statSync('/many',{bigint:true})
    assert.equal(stat.size,fs.statSync('/many',{bigint:true}).size)
    assert.equal(stat.isDirectory(),true)
    assert.throws(()=>proxy.readFileSync('/missing'),error=>error.code==='ENOENT'&&error.message.includes('/missing'))
  })
})

test('large serialized error stacks settle with the original operation error, not an overflow',()=>{
  const {fs}=memfs(),descriptor=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace')
  try{
    Object.defineProperty(Error,'prepareStackTrace',{configurable:true,value:()=> 'frame\n'.repeat(3000)})
    withRealClient(fs,(proxy,host,calls)=>{
      assert.throws(()=>proxy.statSync('/missing'),error=>error instanceof Error&&error.code==='ENOENT')
      assert.ok(calls.some(m=>m.__fs__.continue===true));assert.equal(host.inspect().pendingBytes,0)
    })
  }finally{
    if(descriptor)Object.defineProperty(Error,'prepareStackTrace',descriptor)
    else Reflect.deleteProperty(Error,'prepareStackTrace')
  }
})

test('a continued result never repeats the original filesystem operation',()=>{
  const {fs}=memfs(),original=fs.readFileSync;let calls=0
  fs.writeFileSync('/large',Buffer.alloc(80000,7))
  fs.readFileSync=function(...args){calls++;assert.equal(this,fs);return Reflect.apply(original,this,args)}
  withRealClient(fs,proxy=>assert.equal(proxy.readFileSync('/large').length,80000))
  assert.equal(calls,1)
})

test('unserializable thrown values settle even if their string conversion throws',()=>{
  const {fs}=memfs();fs.statSync=()=>{throw {self:null,toJSON(){throw Error('json')},toString(){throw Error('string')}}}
  withRealClient(fs,(proxy,host)=>{
    assert.throws(()=>proxy.statSync('/value'),error=>error==='Unserializable thrown value')
    assert.equal(host.inspect().pendingBytes,0)
  })
})

test('waiting uses a status predicate and does not accept a notification as completion',()=>{
  const f=fixture();f.fs.writeFileSync('/small','ok')
  let queued,waits=0
  const client=createWasiFilesystemClient({}, {decodeValue:(_fs,bytes)=>new TextDecoder().decode(bytes),
    send:message=>{queued=message},wait:()=>{waits++;if(waits===2)f.host({data:queued});return 'ok'}})
  assert.equal(client.readFileSync('/small','utf8'),'ok');assert.equal(waits,2)
})

test('a missing service has one deadline even when spurious wakeups continue',()=>{
  const messages=[],waits=[],times=[0,0,25,70,100]
  const proxy=createWasiFilesystemClient({}, {decodeValue(){assert.fail('No reply was published')},
    timeoutMs:100,now:()=>times.shift(),send:message=>messages.push(message),
    wait:(_lane,_index,_expected,remaining)=>{waits.push(remaining);return 'ok'}})
  assert.throws(()=>proxy.readFileSync('/file'),error=>error.code==='ERR_WASI_FILESYSTEM_TIMEOUT')
  assert.deepEqual(waits,[100,75,30])
  assert.equal(messages.length,2)
  assert.equal(messages[1].__fs__.cancel,true)
  assert.equal(messages[1].__fs__.id,messages[0].__fs__.id)
})

test('a timed-out wait accepts a reply already published at its boundary',()=>{
  const f=fixture();f.fs.writeFileSync('/small','ok')
  let queued
  const proxy=createWasiFilesystemClient({}, {decodeValue:(_fs,bytes)=>new TextDecoder().decode(bytes),
    timeoutMs:100,now:()=>0,send:message=>{queued=message},
    wait:()=>{f.host({data:queued});return 'timed-out'}})
  assert.equal(proxy.readFileSync('/small','utf8'),'ok')
  f.host.dispose()
})

test('a continued reply keeps the original deadline and cancellation releases its bytes',()=>{
  const f=fixture();f.fs.writeFileSync('/large',Buffer.alloc(30000))
  const messages=[],waits=[],times=[0,40,100]
  let reads=0
  const read=f.fs.readFileSync
  f.fs.readFileSync=function(...args){reads++;return Reflect.apply(read,this,args)}
  const proxy=createWasiFilesystemClient({}, {decodeValue(){assert.fail('Reply is incomplete')},
    timeoutMs:100,now:()=>times.shift(),
    send:message=>{messages.push(message);if(!message.__fs__.continue)f.host({data:message})},
    wait:(_lane,_index,_expected,remaining)=>{waits.push(remaining);return 'ok'}})
  assert.throws(()=>proxy.readFileSync('/large'),error=>error.code==='ERR_WASI_FILESYSTEM_TIMEOUT')
  assert.deepEqual(waits,[60])
  assert.equal(reads,1)
  assert.equal(messages.filter(message=>message.__fs__.continue).length,1)
  assert.equal(messages.at(-1).__fs__.cancel,true)
  assert.equal(f.host.inspect().pendingBytes,0)
  f.host.dispose()
})

test('a wait timeout settles immediately and invalid timeouts cannot disable the limit',()=>{
  const messages=[]
  const proxy=createWasiFilesystemClient({}, {decodeValue(){assert.fail('No reply was published')},
    timeoutMs:100,now:()=>0,send:message=>messages.push(message),wait:()=> 'timed-out'})
  assert.throws(()=>proxy.statSync('/file'),error=>error.code==='ERR_WASI_FILESYSTEM_TIMEOUT')
  assert.equal(messages.at(-1).__fs__.cancel,true)
  for(const timeoutMs of [0,-1,NaN,Infinity,'100'])
    assert.throws(()=>createWasiFilesystemClient({}, {decodeValue(){},timeoutMs}),RangeError)
  assert.throws(()=>createWasiFilesystemClient({}, {decodeValue(){},now:null}),TypeError)
})

test('failure of error encoding and its fallback still publishes terminal status',()=>{
  const original=TextEncoder.prototype.encode
  const host=createWasiFilesystemHost({readFileSync(){throw Error('original')}},{
    getType:()=>6,encodeValue(){throw Error('codec failed')},
  }),sab=lane()
  try{
    TextEncoder.prototype.encode=()=>{throw Error('fallback encoder failed')}
    host({data:{__fs__:{protocol:'tanstack-wasi-fs-1',id:1,sab,type:'readFileSync',payload:[]}}})
    assert.equal(sab[0],3)
    assert.equal(new TextDecoder().decode(new Uint8Array(sab.buffer,16,sab[3])),'WASI filesystem reply encoding failed')
    assert.equal(host.inspect().pendingBytes,0)
  }finally{TextEncoder.prototype.encode=original;host.dispose()}
})

test('malformed continuation does not replay work, and cancellation clears the held reply',()=>{
  const f=fixture();f.fs.writeFileSync('/large',Buffer.alloc(30000))
  const sab=lane(),request={protocol:'tanstack-wasi-fs-1',id:1,sab,type:'readFileSync',payload:['/large']}
  f.host({data:{__fs__:request}});assert.equal(sab[0],2);assert.equal(f.host.inspect().pendingBytes,30000)
  sab[0]=21;f.host({data:{__fs__:{...request,continue:true,offset:1}}})
  assert.equal(sab[0],3)
  f.host({data:{__fs__:{...request,cancel:true}}});assert.equal(f.host.inspect().pendingBytes,0)
  sab[0]=21;f.host({data:{__fs__:{...request,id:2,type:'existsSync',payload:['/large']}}})
  assert.equal(sab[0],0)
})

test('worker termination disposes held reply bytes and wakes a pending continuation',()=>{
  const f=fixture();f.fs.writeFileSync('/large',Buffer.alloc(30000))
  class Worker extends EventTarget{terminate(...args){this.args=args;return 17}}
  const worker=new Worker();manageWasiFilesystemWorker(worker,f.host)
  const sab=lane();f.host({data:{__fs__:{protocol:'tanstack-wasi-fs-1',id:1,sab,type:'readFileSync',payload:['/large']}}})
  sab[0]=21
  assert.equal(worker.terminate('original'),17);assert.deepEqual(worker.args,['original'])
  assert.equal(sab[0],3);assert.deepEqual(f.host.inspect(),{disposed:true,pendingBytes:0})
})

test('both pinned endpoints and codecs are required before compiling a replacement',()=>{
  assert.throws(()=>replaceWasiFsProxy('export const value=1',transport),/Both proxy/)
  assert.throws(()=>replaceWasiFsProxy(source.replace('export const createFsProxy','const createFsProxy'),transport),/export changed/)
  assert.throws(()=>replaceWasiFsProxy(source.replace('const encodeValue','const changedCodec'),transport),/codecs missing/)
})
