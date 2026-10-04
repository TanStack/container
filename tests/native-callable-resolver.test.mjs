import test from 'node:test'
import assert from 'node:assert/strict'
import {probeCallableResolver} from './fixtures/native-callable-resolver.mjs'

test('callable probe exercises sequential and concurrent private callbacks',async()=>{
  const states=[]
  let reads=0
  const result=await probeCallableResolver(config=>({resolveId:{order:'pre',async handler(id,importer,options){
    assert.equal(importer,'/app/fixture/index.js')
    assert.equal(options.kind,'dynamic-import')
    if(id.startsWith('#'))assert.equal(config.resolveSubpathImports(id,importer,false,false),'./target.js')
    return {id:'/app/fixture/target.js'}
  }}}),{root:'/app',report:state=>states.push(structuredClone(state)),readPackage:path=>{
    reads++;assert.equal(path,'/app/fixture/package.json')
    return JSON.stringify({imports:{'#target':'./target.js'}})
  }})
  assert.equal(result.results.length,18);assert.equal(result.callbacks,9)
  assert.equal(reads,9)
  assert.equal(result.events.filter(row=>row.phase==='callback-return').length,9)
  assert.deepEqual(result.failures,[])
  assert.equal(states.at(-1).results.length,18)
})

test('callback read errors stay visible and do not stop the other resolver calls',async()=>{
  const result=await probeCallableResolver(config=>({resolveId(id,importer){
    if(id.startsWith('#'))config.resolveSubpathImports(id,importer,false,false)
    return {id:'/app/fixture/target.js'}
  }}),{root:'/app',readPackage:()=>{throw Error('Package read failed')}})
  assert.equal(result.results.length,9);assert.equal(result.callbacks,9)
  assert.equal(result.failures.length,9)
  assert.ok(result.failures.every(row=>row.error.includes('Package read failed')))
})

test('null resolutions remain failures without hiding the remaining calls',async()=>{
  const result=await probeCallableResolver(config=>({resolveId(id,importer){
    if(id.startsWith('#'))config.resolveSubpathImports(id,importer,false,false)
    return null
  }}),{root:'/app'})
  assert.equal(result.results.length,18);assert.equal(result.callbacks,9)
  assert.equal(result.failures.length,18)
  assert.ok(result.results.every(row=>row.resolved===null))
})

test('control timeouts are recorded and do not claim successful resolution',async()=>{
  const result=await probeCallableResolver(config=>({resolveId(id,importer){
    if(id.startsWith('#')){config.resolveSubpathImports(id,importer,false,false);return new Promise(()=>{})}
    return {id:'/app/fixture/target.js'}
  }}),{root:'/app',timeoutMs:5})
  assert.equal(result.results.length,9);assert.equal(result.callbacks,9)
  assert.equal(result.failures.length,9)
  assert.ok(result.failures.every(row=>row.error.includes('timed out')))
})
