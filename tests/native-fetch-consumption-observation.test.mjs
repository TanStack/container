import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installFetchConsumptionObservation} from '../scripts/native-fetch-consumption-observation.mjs'

const origin='https://preview.invalid'
function fixture({origin:currentOrigin=origin,maxEvents=256,consoleThrows=false}={}){
  let time=0,fetchCalls=0,reads=0,cancels=0,clones=0,jsonCalls=0,fetchThis,fetchArgs
  let fetchResult,jsonResult,readResult
  class Reader{
    read(){reads++;return readResult}
    cancel(){cancels++;return Promise.resolve()}
    releaseLock(){return undefined}
  }
  class Stream{getReader(){return new Reader()}}
  class Response{
    constructor(){this.status=200;this.body=new Stream()}
    json(){jsonCalls++;return jsonResult}
    clone(){clones++;return new Response()}
  }
  const context={Promise,URL,WeakMap,location:{origin:currentOrigin,href:currentOrigin+'/example'},
    performance:{now:()=>time},document:{visibilityState:'visible'},Response,
    ReadableStream:Stream,ReadableStreamDefaultReader:Reader,
    console:{info(){if(consoleThrows)throw Error('console unavailable')}},
    fetch:function(...args){fetchCalls++;fetchThis=this;fetchArgs=args;return fetchResult},
  }
  runInNewContext(`(${installFetchConsumptionObservation.toString()})(${JSON.stringify({previewOrigin:origin,pathPrefix:'/rpc/',maxEvents})})`,context)
  return {context,Response,setTime:value=>time=value,setFetch:value=>fetchResult=value,setJSON:value=>jsonResult=value,
    setRead:value=>readResult=value,counts:()=>({fetchCalls,reads,cancels,clones,jsonCalls}),
    fetchCall:()=>({thisValue:fetchThis,args:fetchArgs}),rows:()=>JSON.parse(JSON.stringify(context.__nativeFetchConsumptionObservation?.rows))}
}

test('fetch and body calls return original promises and preserve receivers and arguments',async()=>{
  const f=fixture(),response=new f.Response(),promise=Promise.resolve(response)
  f.setFetch(promise)
  const input='/rpc/private-id?token=secret',options={method:'POST',body:'private data'},receiver={}
  assert.equal(f.context.fetch.call(receiver,input,options),promise)
  await promise
  assert.equal(f.fetchCall().thisValue,receiver)
  assert.deepEqual(f.fetchCall().args,[input,options])
  let resolve
  const bodyPromise=new Promise(done=>resolve=done)
  f.setJSON(bodyPromise)
  assert.equal(response.json(),bodyPromise)
  assert.deepEqual(f.rows().map(row=>row.kind),['fetch-start','fetch-fulfilled','json-start'])
  f.setTime(40);resolve({private:'payload'});await bodyPromise
  assert.equal(f.rows().at(-1).kind,'json-fulfilled')
  assert.equal(f.rows().at(-1).elapsedMs,40)
  assert.deepEqual(f.counts(),{fetchCalls:1,reads:0,cancels:0,clones:0,jsonCalls:1})
  const saved=JSON.stringify(f.rows())
  for(const privateValue of ['private-id','secret','private data','payload'])assert.ok(!saved.includes(privateValue))
})

test('reader events observe application reads without pulling or canceling extra chunks',async()=>{
  const f=fixture(),response=new f.Response()
  const fetched=Promise.resolve(response);f.setFetch(fetched);await f.context.fetch('/rpc/value')
  const reader=response.body.getReader(),chunk=new Uint8Array([1,2,3])
  const first=Promise.resolve({done:false,value:chunk});f.setRead(first)
  assert.equal(reader.read(),first);assert.equal((await first).value,chunk)
  const last=Promise.resolve({done:true});f.setRead(last);assert.equal(reader.read(),last);await last
  reader.releaseLock()
  assert.deepEqual(f.rows().filter(row=>row.kind==='read-fulfilled').map(({done,bytes})=>({done,bytes})),[
    {done:false,bytes:3},{done:true,bytes:0}])
  assert.deepEqual(f.counts(),{fetchCalls:1,reads:2,cancels:0,clones:0,jsonCalls:0})
})

test('rejected original promises remain rejected even if recording throws',async()=>{
  const f=fixture({consoleThrows:true}),error=Error('private error'),promise=Promise.reject(error)
  f.setFetch(promise)
  assert.equal(f.context.fetch('/rpc/value'),promise)
  await assert.rejects(promise,reason=>reason===error)
  assert.equal(f.rows().at(-1).kind,'fetch-rejected')
  assert.ok(!JSON.stringify(f.rows()).includes('private error'))
})

test('observation excludes other origins and paths and caps retained events',async()=>{
  const outside=fixture({origin:'https://owner.invalid'})
  assert.equal(outside.context.__nativeFetchConsumptionObservation,undefined)
  const f=fixture({maxEvents:2}),response=new f.Response(),promise=Promise.resolve(response)
  f.setFetch(promise)
  await f.context.fetch('https://other.invalid/rpc/value');await f.context.fetch('/assets/a.js')
  assert.deepEqual(f.rows(),[])
  await f.context.fetch('/rpc/first');await f.context.fetch('/rpc/second')
  assert.equal(f.rows().length,2);assert.equal(f.context.__nativeFetchConsumptionObservation.limited,true)
  assert.deepEqual(f.counts(),{fetchCalls:4,reads:0,cancels:0,clones:0,jsonCalls:0})
})
