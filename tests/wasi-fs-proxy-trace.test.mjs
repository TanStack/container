import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {memfs} from 'memfs'
import {traceWasiFsProxy} from '../scripts/wasi-fs-proxy-trace.mjs'

const require=createRequire(import.meta.url)
const source=readFileSync(join(dirname(require.resolve('@napi-rs/wasm-runtime')),'fs-proxy.js'),'utf8')
const instantiate=global=>new Function('globalThis',traceWasiFsProxy(source).replaceAll('export const ','const ')+';return createOnMessage;')(global)
const lane=()=>{const header=new Int32Array(new SharedArrayBuffer(16+10240));header[0]=21;return header}
const request=(sab,method,args)=>({data:{__fs__:{sab,type:method,payload:args}}})

test('filesystem tracing records only oversized-reply metadata and preserves ordinary bytes',()=>{
  const rows=[],{fs}=memfs(),handle=instantiate({Buffer,postMessage:row=>rows.push(row)})
  fs.writeFileSync('/private-file',Buffer.alloc(10240,7))
  const small=lane();handle(fs)(request(small,'readFileSync',['/private-file']))
  assert.equal(small[0],0);assert.equal(small[2],10240)
  assert.deepEqual(new Uint8Array(small.buffer,16,10240),new Uint8Array(10240).fill(7))
  assert.equal(rows.length,0)
  fs.writeFileSync('/private-file',Buffer.alloc(10241,7))
  const large=lane();handle(fs)(request(large,'readFileSync',['/private-file']))
  assert.equal(large[0],1)
  const metadata=JSON.parse(rows[0].phase.slice('wasi-fs-overflow:'.length))
  assert.deepEqual(metadata,{method:'readFileSync',reply:'result',encodedBytes:10241,limit:10240,wireType:10,wireStatus:21})
  assert.equal(JSON.stringify(rows).includes('private-file'),false)
})

test('recording errors do not change overflow errors or prevent terminal publication',()=>{
  const {fs}=memfs(),handle=instantiate({Buffer,postMessage(){throw Error('Recorder')}})
  fs.writeFileSync('/large',Buffer.alloc(10241))
  const sab=lane();handle(fs)(request(sab,'readFileSync',['/large']))
  assert.equal(sab[0],1)
  const value=JSON.parse(new TextDecoder().decode(new Uint8Array(sab.buffer,16,sab[2])))
  assert.equal(value.message,'payload overflow')
})

test('an oversized fallback error reports its method and leaves the original broken status visible',()=>{
  const rows=[],{fs}=memfs(),handle=instantiate({Buffer,postMessage:row=>rows.push(row)})
  const descriptor=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace'),sab=lane()
  try{
    Object.defineProperty(Error,'prepareStackTrace',{configurable:true,value:()=> 'frame\n'.repeat(3000)})
    assert.throws(()=>handle(fs)(request(sab,'statSync',['/private-missing-file'])),/payload overflow/)
    assert.equal(sab[0],21)
    assert.equal(rows.length,1)
    const metadata=JSON.parse(rows[0].phase.slice('wasi-fs-overflow:'.length))
    assert.equal(metadata.method,'statSync');assert.equal(metadata.reply,'error')
    assert.equal(metadata.wireStatus,21);assert.equal(metadata.wireType,6)
    assert.ok(metadata.encodedBytes>metadata.limit)
    assert.equal(JSON.stringify(rows).includes('private-missing-file'),false)
  }finally{
    if(descriptor)Object.defineProperty(Error,'prepareStackTrace',descriptor)
    else Reflect.deleteProperty(Error,'prepareStackTrace')
  }
})

test('changed or absent proxy shapes reject diagnostic compilation',()=>{
  assert.throws(()=>traceWasiFsProxy('export const value = 1'),/exactly one/)
  assert.throws(()=>traceWasiFsProxy(source.replace('payload.length > RESPONSE_PAYLOAD_SIZE','payload.length >= RESPONSE_PAYLOAD_SIZE')),/predicate changed/)
  assert.throws(()=>traceWasiFsProxy(source.replace('writeResponsePayload(sab, v)','writeResponsePayload(sab, other)')),/reply call changed/)
})
