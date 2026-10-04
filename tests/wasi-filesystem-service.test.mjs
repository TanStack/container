import test from 'node:test'
import assert from 'node:assert/strict'
import {memfs} from 'memfs'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'
import {createWasiFilesystemService,createWasiFilesystemEndpoint} from '../src/native/wasi-filesystem-service.mjs'
import {connectWasiFilesystemPort,createWasiFilesystemClient} from '../src/native/wasi-fs-transport.mjs'

const require=createRequire(import.meta.url),runtime=dirname(require.resolve('@napi-rs/wasm-runtime'))
assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'))).version,'1.2.4')
const source=replaceWasiFsProxy(readFileSync(join(runtime,'fs-proxy.js'),'utf8'),
  pathToFileURL(join(process.cwd(),'src/native/wasi-fs-transport.mjs')).href)+'\nexport {decodeValue};'
const codec=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))

class Port extends EventTarget{
  started=false;closed=false
  start(){this.started=true}
  close(){this.closed=true}
  postMessage(data){this.dispatchEvent(new MessageEvent('message',{data}))}
}
function fixture(){
  const {fs}=memfs(),handlers=[]
  const service=createWasiFilesystemService(fs,endpoint=>{
    const handler=codec.createOnMessage(endpoint);handlers.push(handler);return handler
  })
  const connect=id=>{
    const port=new Port();service.onMessage({data:{type:'tanstack-wasi-filesystem-connect',id,port}})
    assert.equal(port.started,true)
    return {port,fs:createWasiFilesystemClient(fs,{decodeValue:codec.decodeValue,send:message=>port.postMessage(message)})}
  }
  return {fs,service,handlers,connect}
}

test('independent compiler endpoints read and change one authoritative filesystem',()=>{
  const f=fixture(),first=f.connect('main'),second=f.connect('thread')
  try{
    first.fs.mkdirSync('/app');first.fs.writeFileSync('/app/file','before')
    assert.equal(second.fs.readFileSync('/app/file','utf8'),'before')
    second.fs.writeFileSync('/app/file','after')
    assert.equal(first.fs.readFileSync('/app/file','utf8'),'after')
    assert.equal(first.fs.statSync('/app',{bigint:true}).isDirectory(),true)
    assert.throws(()=>second.fs.readFileSync('/missing'),error=>error.code==='ENOENT')
    assert.deepEqual(f.service.inspect(),{disposed:false,clients:2,descriptors:0})
  }finally{f.service.dispose()}
})

test('scoped changes survive child release without leaking sibling writes',()=>{
  const f=fixture(),parent=f.connect('main'),child=f.connect('main/child'),grandchild=f.connect('main/child/compiler'),sibling=f.connect('sibling')
  try{
    parent.fs.mkdirSync('/app')
    child.fs.writeFileSync('/app/child','one')
    grandchild.fs.writeFileSync('/app/compiled','two')
    sibling.fs.writeFileSync('/app/sibling','three')
    const fd=child.fs.openSync('/app/descriptor','w')
    child.fs.writeSync(fd,Buffer.from('bytes'))
    f.service.release('main/child/compiler')
    assert.deepEqual(parent.fs.__tanstackFilesystemChanges('main/child'),['/app/child','/app/compiled','/app/descriptor'])
    f.service.releaseScope('main/child')
    assert.deepEqual(parent.fs.__tanstackFilesystemChanges('main'),['/app','/app/child','/app/compiled','/app/descriptor'])
    assert.throws(()=>f.fs.fstatSync(fd),error=>error.code==='EBADF')
    assert.equal(sibling.fs.readFileSync('/app/sibling','utf8'),'three')
    assert.equal(f.service.inspect().descriptors,0)
  }finally{f.service.dispose()}
})

test('descriptor tables are shared but endpoint disposal closes only its owned handles',()=>{
  const f=fixture(),first=f.connect('main'),second=f.connect('thread')
  try{
    f.fs.writeFileSync('/file','value')
    const root=first.fs.openSync('/','r'),file=second.fs.openSync('/file','r')
    assert.equal(second.fs.fstatSync(root,{bigint:true}).isDirectory(),true)
    const shared=new Uint8Array(new SharedArrayBuffer(5))
    assert.equal(first.fs.readSync(file,shared,0,5,0),5)
    assert.equal(new TextDecoder().decode(shared),'value')
    f.service.release('thread')
    assert.equal(second.port.closed,true)
    assert.throws(()=>f.fs.fstatSync(file),error=>error.code==='EBADF')
    assert.equal(first.fs.fstatSync(root).isDirectory(),true)
    first.fs.closeSync(root)
    assert.deepEqual(f.service.inspect(),{disposed:false,clients:1,descriptors:0})
  }finally{f.service.dispose()}
})

test('closing a descriptor through a different endpoint removes its original ownership',()=>{
  const f=fixture(),first=f.connect('main'),second=f.connect('thread')
  try{
    const descriptor=first.fs.openSync('/','r')
    second.fs.closeSync(descriptor)
    assert.equal(f.service.inspect().descriptors,0)
    f.service.release('main');f.service.release('main')
    assert.deepEqual(f.service.inspect(),{disposed:false,clients:1,descriptors:0})
  }finally{f.service.dispose()}
})

test('releasing a client clears continued replies and wakes a waiting lane',()=>{
  const f=fixture(),client=f.connect('main')
  try{
    f.fs.writeFileSync('/large',Buffer.alloc(30000,7))
    const sab=new Int32Array(new SharedArrayBuffer(16+10240));sab[0]=21
    client.port.postMessage({__fs__:{protocol:'tanstack-wasi-fs-1',id:1,sab,type:'readFileSync',payload:['/large']}})
    assert.equal(sab[0],2);assert.equal(f.handlers[0].inspect().pendingBytes,30000)
    sab[0]=21;f.service.release('main')
    assert.equal(sab[0],3)
    assert.deepEqual(f.handlers[0].inspect(),{disposed:true,pendingBytes:0})
  }finally{f.service.dispose()}
})

test('duplicate endpoints cannot replace an existing client and disposal is final',()=>{
  const f=fixture(),client=f.connect('main'),duplicate=new Port()
  assert.throws(()=>f.service.onMessage({data:{type:'tanstack-wasi-filesystem-connect',id:'main',port:duplicate}}))
  assert.equal(duplicate.closed,true);assert.equal(client.port.closed,false)
  f.service.dispose();f.service.dispose()
  assert.equal(client.port.closed,true)
  assert.deepEqual(f.service.inspect(),{disposed:true,clients:0,descriptors:0})
  assert.throws(()=>f.connect('late'))
})

test('the default compiler client routes through its direct service port',()=>{
  const f=fixture(),client=f.connect('main'),disconnect=connectWasiFilesystemPort(client.port)
  try{
    assert.throws(()=>connectWasiFilesystemPort(new Port()),/already connected/)
    const proxy=codec.createFsProxy(f.fs)
    proxy.writeFileSync('/direct','works')
    assert.equal(proxy.readFileSync('/direct','utf8'),'works')
  }finally{disconnect();disconnect();f.service.dispose()}
  assert.equal(client.port.closed,true)
})

test('endpoint handoff sends a transferable port and release is idempotent',()=>{
  const sent=[],control={postMessage(...args){sent.push(args)}}
  const endpoint=createWasiFilesystemEndpoint(control,'main')
  try{
    assert.equal(sent[0][0].type,'tanstack-wasi-filesystem-connect')
    assert.equal(sent[0][0].id,'main')
    assert.equal(sent[0][1][0],sent[0][0].port)
    endpoint.dispose();endpoint.dispose()
    assert.deepEqual(sent[1],[{type:'tanstack-wasi-filesystem-release',id:'main'}])
    assert.equal(sent.length,2)
  }finally{endpoint.dispose();sent[0][0].port.close()}
})

test('named codecs share one client table and unknown codecs cannot register',()=>{
  const {fs}=memfs(),selected=[]
  const service=createWasiFilesystemService(fs,Object.fromEntries(['first','second'].map(name=>[name,endpoint=>{
    selected.push(name);return codec.createOnMessage(endpoint)
  }])))
  try{
    const first=new Port(),second=new Port()
    service.onMessage({data:{type:'tanstack-wasi-filesystem-connect',id:'one',codec:'first',port:first}})
    service.onMessage({data:{type:'tanstack-wasi-filesystem-connect',id:'two',codec:'second',port:second}})
    assert.deepEqual(selected,['first','second']);assert.equal(service.inspect().clients,2)
    for(const codec of [undefined,'unknown',1]){
      const port=new Port()
      assert.throws(()=>service.onMessage({data:{type:'tanstack-wasi-filesystem-connect',id:'bad',codec,port}}))
      assert.equal(port.closed,true);assert.equal(service.inspect().clients,2)
    }
  }finally{service.dispose()}
})

test('named codec handoff includes the exact codec and rejects invalid names',()=>{
  const sent=[],control={postMessage(...args){sent.push(args)}}
  const endpoint=createWasiFilesystemEndpoint(control,'main',{codec:'1.1.4'})
  try{assert.equal(sent[0][0].codec,'1.1.4');assert.equal(sent[0][1][0],sent[0][0].port)}
  finally{endpoint.dispose();sent[0][0].port.close()}
  for(const codec of ['',null,42])assert.throws(()=>createWasiFilesystemEndpoint(control,'bad',{codec}),TypeError)
})

test('invalid factories and failed initialization leave no registered endpoint',()=>{
  const {fs}=memfs()
  for(const factories of [{},{bad:null}])assert.throws(()=>createWasiFilesystemService(fs,factories),TypeError)
  for(const createHandler of [()=>{throw Error('initialization failed')},()=>()=>{}]){
    const service=createWasiFilesystemService(fs,createHandler),port=new Port()
    assert.throws(()=>service.onMessage({data:{type:'tanstack-wasi-filesystem-connect',id:'main',port}}))
    assert.equal(port.closed,true);assert.equal(service.inspect().clients,0);service.dispose()
  }
})
