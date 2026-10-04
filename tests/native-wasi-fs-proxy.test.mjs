import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {readFileSync} from 'node:fs'
import {memfs} from 'memfs'

// Negative controls for the actual installed dependency, not runtime acceptance.
const require=createRequire(import.meta.url)
const root=dirname(require.resolve('@napi-rs/wasm-runtime'))
const {createOnMessage}=await import(pathToFileURL(join(root,'fs-proxy.js')).href)
assert.equal(JSON.parse(readFileSync(join(root,'package.json'))).version,'1.2.4')
const lane=()=>{
  const result=new Int32Array(new SharedArrayBuffer(16+10240))
  Atomics.store(result,0,21)
  return result
}
const request=(sab,type,payload)=>({data:{__fs__:{sab,type,payload}}})

test('the installed WASI file proxy reports oversized file replies as errors',()=>{
  const {fs}=memfs(),sab=lane()
  fs.writeFileSync('/large.bin',Buffer.alloc(10241,7))
  createOnMessage(fs)(request(sab,'readFileSync',['/large.bin']))
  assert.equal(Atomics.load(sab,0),1)
  assert.equal(Atomics.load(sab,1),6)
  const length=Atomics.load(sab,2)
  assert.ok(length<=10240)
  const value=JSON.parse(new TextDecoder().decode(new Uint8Array(sab.buffer,16,length)))
  assert.equal(value.message,'payload overflow')
})

test('an oversized error stack can throw before the real proxy publishes terminal status',()=>{
  const {fs}=memfs(),small=lane()
  createOnMessage(fs)(request(small,'statSync',['/missing']))
  assert.equal(Atomics.load(small,0),1)
  const descriptor=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace')
  const sab=lane()
  try{
    Object.defineProperty(Error,'prepareStackTrace',{configurable:true,value:()=> 'frame\n'.repeat(3000)})
    assert.throws(()=>createOnMessage(fs)(request(sab,'statSync',['/missing'])),/payload overflow/)
    assert.equal(Atomics.load(sab,0),21)
    assert.ok(Atomics.load(sab,2)>10240)
    // Do not call Atomics.wait. The unchanged waiting status is the failure.
  }finally{
    if(descriptor)Object.defineProperty(Error,'prepareStackTrace',descriptor)
    else Reflect.deleteProperty(Error,'prepareStackTrace')
  }
})
