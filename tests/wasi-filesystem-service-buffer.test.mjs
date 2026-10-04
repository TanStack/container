import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {Worker} from 'node:worker_threads'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fs as constructors} from 'memfs'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'
import {createWasiFilesystemClient} from '../src/native/wasi-fs-transport.mjs'
import {createWasiFilesystemEndpoint} from '../src/native/wasi-filesystem-service.mjs'

const require=createRequire(import.meta.url),runtime=dirname(require.resolve('@napi-rs/wasm-runtime'))
assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'))).version,'1.2.4')
const source=replaceWasiFsProxy(readFileSync(join(runtime,'fs-proxy.js'),'utf8'),
  new URL('../src/native/wasi-fs-transport.mjs',import.meta.url).href)+'\nexport {decodeValue};'
const codecURL='data:text/javascript;base64,'+Buffer.from(source).toString('base64')
const codec=await import(codecURL)

async function fixture(fn){
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {createNativeFilesystemBackend}=await import(workerData.backendURL),{fs}=createNativeFilesystemBackend();
      const {createWasiFilesystemService}=await import(workerData.serviceURL);
      const codec=await import(workerData.codecURL);
      fs.writeFileSync('/file','abcdefghij');
      const service=createWasiFilesystemService(fs,codec.createOnMessage);
      parentPort.on('message',data=>service.onMessage({data}));
      parentPort.postMessage({type:'ready'});
    })().catch(error=>{throw error});
  `,{eval:true,workerData:{backendURL:process.env.NATIVE_FILESYSTEM_BACKEND_URL??
      new URL('../src/native/filesystem-backend.mjs',import.meta.url).href,codecURL,
    serviceURL:new URL('../src/native/wasi-filesystem-service.mjs',import.meta.url).href}})
  let endpoint
  try{
    assert.deepEqual((await once(worker,'message',{signal:AbortSignal.timeout(5000)}))[0],{type:'ready'})
    endpoint=createWasiFilesystemEndpoint(worker,'node-client')
    const fs=createWasiFilesystemClient(constructors, {decodeValue:codec.decodeValue,
      timeoutMs:2000,send:message=>endpoint.port.postMessage(message)})
    await fn(fs)
  }finally{endpoint?.dispose();await worker.terminate()}
}

test('an ordinary Node buffer receives a remote read without changing its surrounding bytes', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r'),backing=Buffer.alloc(12,46),buffer=backing.subarray(2,10)
    assert.equal(fs.readSync(fd,buffer,1,3,2),3)
    assert.equal(backing.toString(),'...cde......')
    assert.equal(fs.fstatSync(fd).size,10)
    fs.closeSync(fd)
  })
})

test('remote vector reads preserve view offsets, partial reads and the implicit descriptor cursor', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r')
    const one=Buffer.alloc(6,46),two=new Uint8Array(8).fill(46)
    const first=one.subarray(1,4),second=two.subarray(2,6)
    assert.equal(fs.readvSync(fd,[first,second],null),7)
    assert.equal(one.toString(),'.abc..')
    assert.equal(new TextDecoder().decode(two),'..defg..')
    const tail=Buffer.alloc(5,46)
    assert.equal(fs.readSync(fd,tail,0,5,null),3)
    assert.equal(tail.toString(),'hij..')
    fs.closeSync(fd)
  })
})

test('positioned scalar and vector service reads do not seek the shared descriptor', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r'),buffer=Buffer.alloc(2)
    assert.equal(fs.readSync(fd,buffer,0,2,5),2)
    assert.equal(buffer.toString(),'fg')
    assert.equal(fs.readSync(fd,buffer,0,2,null),2)
    assert.equal(buffer.toString(),'ab')
    const buffers=[Buffer.alloc(1),Buffer.alloc(2)]
    assert.equal(fs.readvSync(fd,buffers,5),3)
    assert.equal(buffers.map(b=>b.toString()).join(''),'fgh')
    assert.equal(fs.readSync(fd,buffer,0,2,null),2)
    assert.equal(buffer.toString(),'cd')
    fs.closeSync(fd)
  })
})

test('positioned service writes leave the next implicit read at its original cursor', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r+'),buffer=Buffer.alloc(2)
    fs.readSync(fd,buffer,0,2,null)
    assert.equal(fs.writeSync(fd,Buffer.from('XY'),0,2,6),2)
    assert.equal(fs.readSync(fd,buffer,0,2,null),2)
    assert.equal(buffer.toString(),'cd')
    assert.equal(fs.writevSync(fd,[Buffer.from('A'),Buffer.from('B')],8),2)
    assert.equal(fs.readSync(fd,buffer,0,2,null),2)
    assert.equal(buffer.toString(),'ef')
    fs.closeSync(fd)
  })
})

test('shared WASM views still mutate their original memory without a copy-back path', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r'),memory=new Uint8Array(new SharedArrayBuffer(10)).fill(46)
    assert.equal(fs.readSync(fd,memory.subarray(2,8),1,3,0),3)
    assert.equal(new TextDecoder().decode(memory),'...abc....')
    fs.closeSync(fd)
  })
})

test('overlapping vector destinations retain their aliases across the worker boundary', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r'),backing=Buffer.alloc(8,46)
    assert.equal(fs.readvSync(fd,[backing.subarray(1,5),backing.subarray(3,7)],0),8)
    assert.equal(backing.toString(),'.abefgh.')
    fs.closeSync(fd)
  })
})

test('non-byte views and read options retain byte-based Node offsets', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r'),backing=new Uint8Array(12).fill(46)
    const view=new Uint16Array(backing.buffer,2,4)
    assert.equal(fs.readSync(fd,view,{offset:1,length:3,position:2}),3)
    assert.equal(new TextDecoder().decode(backing),'...cde......')
    const data=new DataView(backing.buffer,6,4)
    assert.equal(fs.readSync(fd,data,0,2,0),2)
    assert.equal(new TextDecoder().decode(backing),'...cdeab....')
    fs.closeSync(fd)
  })
})

test('failed reads keep filesystem errors and leave ordinary caller buffers unchanged', {timeout:10000},async()=>{
  await fixture(fs=>{
    const buffer=Buffer.alloc(5,46)
    assert.throws(()=>fs.readSync(12345,buffer,0,3,0),error=>error.code==='EBADF')
    assert.equal(buffer.toString(),'.....')
  })
})

test('a read without options fills the view and invalid options keep a Node argument error', {timeout:10000},async()=>{
  await fixture(fs=>{
    const fd=fs.openSync('/file','r'),buffer=Buffer.alloc(3,46)
    assert.equal(fs.readSync(fd,buffer),3)
    assert.equal(buffer.toString(),'abc')
    assert.throws(()=>fs.readSync(fd,buffer,1),error=>error.code==='ERR_INVALID_ARG_TYPE')
    fs.closeSync(fd)
  })
})
