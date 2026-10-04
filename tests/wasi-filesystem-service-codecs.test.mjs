import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {Worker} from 'node:worker_threads'
import {fs as constructors} from 'memfs'
import {createWasiFilesystemClient} from '../src/native/wasi-fs-transport.mjs'
import {createWasiFilesystemEndpoint} from '../src/native/wasi-filesystem-service.mjs'
import {loadFilesystemCodecs} from './fixtures/wasi-filesystem-codecs.mjs'

const inputs=loadFilesystemCodecs()
const codecs=Object.fromEntries(await Promise.all(Object.entries(inputs).map(async([version,input])=>[version,await import(input.url)])))

test('both pinned compiler codecs share preopens, bytes, cursors and descriptor ownership in one worker', {timeout:10000},async()=>{
  const owner=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {createNativeFilesystemBackend}=await import(workerData.backend);
      const {createWasiFilesystemService}=await import(workerData.service);
      const codecs=Object.fromEntries(await Promise.all(Object.entries(workerData.codecs).map(async([name,url])=>[name,await import(url)])));
      const {fs}=createNativeFilesystemBackend();
      const service=createWasiFilesystemService(fs,Object.fromEntries(Object.entries(codecs).map(([name,codec])=>[name,codec.createOnMessage])));
      parentPort.on('message',data=>{
        if(data.type==='inspect')parentPort.postMessage(service.inspect());
        else service.onMessage({data});
      });
      parentPort.postMessage({type:'ready'});
    })().catch(error=>{throw error});
  `,{eval:true,workerData:{backend:new URL('../src/native/filesystem-backend.mjs',import.meta.url).href,
    service:new URL('../src/native/wasi-filesystem-service.mjs',import.meta.url).href,
    codecs:Object.fromEntries(Object.entries(inputs).map(([name,input])=>[name,input.url]))}})
  const endpoints=[]
  const inspect=async()=>{const result=once(owner,'message',{signal:AbortSignal.timeout(3000)});owner.postMessage({type:'inspect'});return (await result)[0]}
  try{
    assert.deepEqual((await once(owner,'message',{signal:AbortSignal.timeout(3000)}))[0],{type:'ready'})
    const connect=(id,codec)=>{
      const endpoint=createWasiFilesystemEndpoint(owner,id,{codec});endpoints.push(endpoint)
      return createWasiFilesystemClient(constructors,{decodeValue:codecs[codec].decodeValue,
        timeoutMs:3000,send:message=>endpoint.port.postMessage(message)})
    }
    const first=connect('oxide','1.1.4'),second=connect('rolldown','1.2.4')
    // Reserve a root descriptor before any workspace mount, as WASI does.
    const root=first.openSync('/','r'),rootStat=first.fstatSync(root,{bigint:true})
    second.mkdirSync('/app');second.mkdirSync('/tmp')
    const bytes=Buffer.from(Array.from({length:260000},(_,index)=>index%251))
    second.writeFileSync('/app/large',bytes)
    assert.deepEqual(first.readFileSync('/app/large'),bytes)
    assert.equal(second.fstatSync(root,{bigint:true}).ino,rootStat.ino)
    assert.equal(second.fstatSync(root).isDirectory(),true)
    first.symlinkSync('large','/app/link')
    assert.equal(second.lstatSync('/app/link').isSymbolicLink(),true)
    assert.equal(second.readlinkSync('/app/link'),'large')
    assert.deepEqual(first.readdirSync('/app',{withFileTypes:true}).map(entry=>[entry.name,entry.isFile(),entry.isSymbolicLink()]),
      [['large',true,false],['link',false,true]])
    const fd=first.openSync('/app/large','r+'),a=Buffer.alloc(4),b=Buffer.alloc(4)
    assert.equal(second.readSync(fd,a,0,4,null),4);assert.deepEqual(a,bytes.subarray(0,4))
    assert.equal(first.readSync(fd,b,0,4,null),4);assert.deepEqual(b,bytes.subarray(4,8))
    second.writeSync(fd,Buffer.from('changed'),0,7,100)
    first.readSync(fd,a,0,4,null);assert.deepEqual(a,bytes.subarray(8,12))
    assert.equal(first.statSync('/app/large',{bigint:true}).size,260000n)
    for(const fs of [first,second])assert.throws(()=>fs.readFileSync('/missing'),error=>error.code==='ENOENT')
    second.closeSync(fd)
    const replacement=second.openSync('/app/large','r')
    assert.deepEqual(await inspect(),{disposed:false,clients:2,descriptors:2})
    endpoints[0].dispose()
    assert.deepEqual(await inspect(),{disposed:false,clients:1,descriptors:1})
    // Releasing the old descriptor owner must not close a reused descriptor.
    assert.equal(second.fstatSync(replacement).size,260000)
    assert.throws(()=>second.fstatSync(root),error=>error.code==='EBADF')
    second.closeSync(replacement);endpoints[1].dispose()
    assert.deepEqual(await inspect(),{disposed:false,clients:0,descriptors:0})
  }finally{for(const endpoint of endpoints)endpoint.dispose();await owner.terminate()}
})
