import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {safariInstallStageTraceSource} from '../scripts/safari-install-stage-trace.mjs'

test('install tracing preserves native results and keeps metadata separate from RPC replies',async()=>{
  const messages=[],result=Promise.resolve('private response'),request=new EventTarget(),transaction=new EventTarget()
  class Database {transaction(){return transaction}}
  class Decompressor {constructor(format){this.format=format}}
  const context={performance:{now:()=>42},crypto:{subtle:{digest(){return result}}},
    indexedDB:{open(){return request}},IDBDatabase:Database,DecompressionStream:Decompressor,
    fetch(){return result},postMessage(message){messages.push(message)}}
  context.self=context
  runInNewContext(safariInstallStageTraceSource,context)
  assert.equal(context.fetch('private URL'),result)
  assert.equal(context.crypto.subtle.digest('private algorithm','private bytes'),result)
  assert.equal(context.indexedDB.open('private database'),request)
  assert.equal(new context.IDBDatabase().transaction('private store'),transaction)
  request.dispatchEvent(new Event('success'))
  transaction.dispatchEvent(new Event('complete'))
  assert.equal(new context.DecompressionStream('gzip').format,'gzip')
  await result
  assert.ok(messages.some(row=>row.stage==='integrity'&&row.state==='end'))
  assert.ok(messages.some(row=>row.stage==='database-open'&&row.state==='success'))
  assert.ok(messages.every(row=>!Object.hasOwn(row,'id')&&!Object.hasOwn(row,'value')&&!Object.hasOwn(row,'error')))
  assert.equal(JSON.stringify(messages).includes('private'),false)
})

test('install tracing preserves rejection and synchronous errors and stops at its output bound',async()=>{
  const messages=[],error=Error('native failure'),rejected=Promise.reject(error)
  const context={performance:{now:()=>1},fetch(mode){if(mode==='throw')throw error;return rejected},postMessage(row){messages.push(row)}}
  context.self=context
  runInNewContext(safariInstallStageTraceSource,context)
  assert.throws(()=>context.fetch('throw'),candidate=>candidate===error)
  assert.equal(context.fetch(),rejected)
  await assert.rejects(rejected,candidate=>candidate===error)
  for(let i=0;i<2200;i++){try{context.fetch('throw')}catch{}}
  assert.equal(messages.length,2049)
  assert.equal(messages.at(-1).state,'limit')
})

test('response body methods and both reader types preserve receiver, arguments and promises',async()=>{
  const messages=[],calls=[],result=Promise.resolve({private:'payload'})
  class Response {}
  for(const method of ['arrayBuffer','blob','bytes','formData','json','text'])Response.prototype[method]=function(...args){calls.push({receiver:this,method,args});return result}
  class Reader {read(...args){calls.push({receiver:this,method:'read',args});return result}}
  class BYOBReader {read(...args){calls.push({receiver:this,method:'read',args});return result}}
  const context={Response,ReadableStreamDefaultReader:Reader,ReadableStreamBYOBReader:BYOBReader,performance:{now:()=>1},postMessage:row=>messages.push(row)}
  context.self=context
  runInNewContext(safariInstallStageTraceSource,context)
  const receiver=new Response(),argument={private:'argument'}
  for(const method of ['arrayBuffer','blob','bytes','formData','json','text'])assert.equal(receiver[method](argument),result)
  const reader=new Reader(),byob=new BYOBReader(),view=new Uint8Array(2),options={min:1}
  assert.equal(reader.read(argument),result)
  assert.equal(byob.read(view,options),result)
  await result
  assert.ok(calls.slice(0,6).every(call=>call.receiver===receiver&&call.args[0]===argument))
  assert.equal(calls[6].receiver,reader)
  assert.equal(calls[7].receiver,byob)
  assert.equal(calls[7].args[0],view)
  assert.equal(calls[7].args[1],options)
  assert.equal(messages.filter(row=>row.stage==='response-body'&&row.state==='end').length,6)
  assert.equal(messages.filter(row=>row.stage==='stream-read'&&row.state==='end').length,2)
  assert.equal(JSON.stringify(messages).includes('private'),false)
})

test('body and reader failures retain identity even if trace delivery fails',async()=>{
  const failure=Error('private failure'),result=Promise.reject(failure)
  class Response {arrayBuffer(){return result} text(){throw failure}}
  class Reader {read(){throw failure}}
  const context={Response,ReadableStreamDefaultReader:Reader,performance:{now:()=>1},postMessage(){throw Error('trace transport failed')}}
  context.self=context
  runInNewContext(safariInstallStageTraceSource,context)
  assert.equal(new Response().arrayBuffer(),result)
  await assert.rejects(result,error=>error===failure)
  assert.throws(()=>new Response().text(),error=>error===failure)
  assert.throws(()=>new Reader().read(),error=>error===failure)
})

test('source phase sink pairs concurrent stages and rejects arbitrary metadata within its own bound',()=>{
  const messages=[],context={performance:{now:()=>1},postMessage:row=>messages.push(row)}
  context.self=context
  runInNewContext(safariInstallStageTraceSource,context)
  const trace=context.__sandboxInstallPhaseTrace
  const first=trace('tar-extraction','begin'),second=trace('tar-extraction','begin')
  assert.notEqual(first,second)
  trace('workspace-commit','end',first)
  trace('private URL','begin')
  trace('tar-extraction','private payload',first)
  trace('tar-extraction','end',second)
  trace('tar-extraction','error',first)
  trace('tar-extraction','end',first)
  assert.equal(messages.length,4)
  assert.equal(messages[2].traceId,second)
  assert.equal(messages[3].traceId,first)
  for(const stage of ['install-planning','workspace-staging','tar-extraction','package-file-write','workspace-commit']){
    const id=trace(stage,'begin')
    trace(stage,'end',id)
    assert.equal(messages.at(-2).stage,stage)
    assert.equal(messages.at(-1).traceId,id)
    assert.equal(messages.at(-1).state,'end')
  }
  for(let i=0;i<2200;i++){const id=trace('install-planning','begin');trace('install-planning','end',id)}
  assert.equal(messages.length,2049)
  assert.equal(messages.at(-1).state,'limit')
  assert.equal(trace('workspace-staging','begin'),undefined)
})

test('IO exhaustion leaves coarse install phases available with independent limit markers',()=>{
  const messages=[],failure=Error('read failed')
  class Reader {read(){throw failure}}
  const context={ReadableStreamDefaultReader:Reader,performance:{now:()=>1},postMessage:row=>messages.push(row)}
  context.self=context
  runInNewContext(safariInstallStageTraceSource,context)
  const reader=new Reader()
  for(let i=0;i<2200;i++)assert.throws(()=>reader.read(),error=>error===failure)
  assert.equal(messages.length,2049)
  assert.equal(messages.at(-1).channel,'io')
  assert.equal(messages.at(-1).state,'limit')
  const trace=context.__sandboxInstallPhaseTrace
  const id=trace('workspace-commit','begin')
  trace('workspace-commit','end',id)
  assert.equal(messages.at(-1).channel,'phase')
  assert.equal(messages.at(-1).state,'end')
  for(let i=0;i<2200;i++){const phase=trace('tar-extraction','begin');trace('tar-extraction','end',phase)}
  assert.equal(messages.filter(row=>row.channel==='phase').length,2049)
  assert.equal(messages.at(-1).channel,'phase')
  assert.equal(messages.at(-1).state,'limit')
  assert.equal(messages.length,4098)
})
