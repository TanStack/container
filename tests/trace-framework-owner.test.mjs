import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {traceFrameworkOwner} from './sdk/helpers/trace-framework-owner.mjs'

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture({optimized=true}={}){
  const closing=deferred(),body=deferred(),reading=deferred()
  let socket
  const reader={read(){return reading.promise}}
  const response={status:200,headers:new Headers(),arrayBuffer(){return body.promise},body:{getReader(){return reader}}}
  class WorkerHTTP{
    constructor(kernel){this.kernel=kernel}
    async fetch(){socket=await this.kernel.connect();return response}
  }
  const kernel={connect:async()=>({close:()=>closing.promise})}
  const source=traceFrameworkOwner('function create(){return {server:new WorkerHTTP(session.kernel,port)}}')
  const server=new Function('WorkerHTTP','session','port',source+';return create().server')(WorkerHTTP,{kernel},3000)
  return {closing,body,reading,response,reader,server,get socket(){return socket},url:optimized?'http://preview/node_modules/.vite/deps/react.js':'http://preview/src/app.js'}
}

test('close start and settlement are separate, preserving the close promise',async()=>{
  const f=fixture()
  await f.server.fetch({url:f.url})
  const row=globalThis.__frameworkOwnerTrace.requests[0]
  assert.equal(f.socket.close(),f.closing.promise)
  assert.equal(typeof row.closeStarted,'number')
  assert.equal(row.closeSettled,undefined)
  f.closing.resolve()
  await f.closing.promise
  assert.equal(typeof row.closeSettled,'number')
  assert.equal(row.closeError,undefined)
})

test('close rejection is observed without replacing its rejection',async()=>{
  const f=fixture()
  await f.server.fetch({url:f.url})
  const result=f.socket.close(),error=new Error('close failed')
  f.closing.reject(error)
  await assert.rejects(result,value=>value===error)
  const row=globalThis.__frameworkOwnerTrace.requests[0]
  assert.equal(row.closeError,'Error: close failed')
  assert.equal(typeof row.closeSettled,'number')
})

test('arrayBuffer completion observes the actual preview consumption promise',async()=>{
  const f=fixture(),response=await f.server.fetch({url:f.url})
  const row=globalThis.__frameworkOwnerTrace.requests[0]
  assert.equal(response,f.response)
  assert.equal(response.arrayBuffer(),f.body.promise)
  assert.equal(row.bodyDone,undefined)
  f.body.resolve(new ArrayBuffer(0))
  await f.body.promise
  assert.equal(typeof row.bodyDone,'number')
  assert.equal(row.bodyCompletion,'arrayBuffer')
  assert.equal(row.bodyReaderDone,undefined)
})

test('reader done is recorded without replacing reader or read promise',async()=>{
  const f=fixture(),response=await f.server.fetch({url:f.url})
  const reader=response.body.getReader(),row=globalThis.__frameworkOwnerTrace.requests[0]
  assert.equal(reader,f.reader)
  assert.equal(reader.read(),f.reading.promise)
  assert.equal(row.bodyReaderDone,undefined)
  f.reading.resolve({done:true})
  await f.reading.promise
  assert.equal(typeof row.bodyReaderDone,'number')
  assert.equal(row.bodyCompletion,'reader')
})

test('ordinary response methods are left unchanged',async()=>{
  const f=fixture({optimized:false}),arrayBuffer=f.response.arrayBuffer,getReader=f.response.body.getReader
  const response=await f.server.fetch({url:f.url})
  assert.equal(response.arrayBuffer,arrayBuffer)
  assert.equal(response.body.getReader,getReader)
  assert.equal(f.socket.close(),f.closing.promise)
  assert.equal(globalThis.__frameworkOwnerTrace.requests[0].closeStarted,undefined)
  f.closing.resolve()
})

test('non-final reads do not report completion',async()=>{
  const f=fixture(),response=await f.server.fetch({url:f.url})
  response.body.getReader().read()
  f.reading.resolve({done:false,value:new Uint8Array([1])})
  await f.reading.promise
  const row=globalThis.__frameworkOwnerTrace.requests[0]
  assert.equal(row.bodyDone,undefined)
  assert.equal(row.bodyReaderDone,undefined)
})

test('body rejection is recorded without replacing the promise',async()=>{
  const f=fixture(),response=await f.server.fetch({url:f.url})
  const result=response.arrayBuffer(),error=new Error('body failed')
  assert.equal(result,f.body.promise)
  f.body.reject(error)
  await assert.rejects(result,value=>value===error)
  const row=globalThis.__frameworkOwnerTrace.requests[0]
  assert.equal(row.bodyError,'Error: body failed')
  assert.equal(row.bodyDone,undefined)
})

test('owner trace remains opt-in and diagnostic-only',()=>{
  const source=readFileSync(new URL('./sdk/framework-example.spec.mjs',import.meta.url),'utf8')
  assert.match(source,/const traceOwner=process\.env\.SDK_TRACE_OWNER_REQUESTS==='1'/)
  assert.match(source,/if\(traceOwner\)\{\s+const path=join\(directory,'example\/client\.js'\),source=traceFrameworkOwner/)
  assert.match(source,/if\([^\n]*traceOwner[^\n]*\)evidence\.diagnosticOnly=true/)
})
