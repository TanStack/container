import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {retryInvalidatedViteClientTransform} from '../scripts/vite-client-transform-invalidation.mjs'

const source=`async function loadAndTransform(environment,id,url,options,timestamp,mod,resolved){
  const moduleGraph=environment.moduleGraph;
  const result=await environment.work();
  if(timestamp>mod.lastInvalidationTimestamp)moduleGraph.updateModuleTransformResult(mod,result);
  return result;
}`
const compile=retry=>new Function('transformRequest',retryInvalidatedViteClientTransform(source)+';return loadAndTransform;')(retry)
const state=(consumer,lastInvalidationTimestamp,work)=>{
  const publications=[],module={lastInvalidationTimestamp}
  const environment={config:{consumer},work,moduleGraph:{updateModuleTransformResult:(...args)=>publications.push(args)}}
  return {module,environment,publications}
}
test('fresh client output preserves result identity and normal cache publication',async()=>{
  const result={},s=state('client',4,async()=>result)
  const transform=compile(()=>assert.fail('Fresh result must not retry'))
  assert.equal(await transform(s.environment,'id','/module.js',{},5,s.module),result)
  assert.deepEqual(s.publications,[[s.module,result]])
})
test('invalidation during pending work retries through the existing request owner with original options',async()=>{
  let finish
  const original={},fresh={},options={skipFsCheck:true},calls=[]
  const s=state('client',0,()=>new Promise(resolve=>{finish=resolve}))
  const transform=compile((...args)=>{calls.push(args);return Promise.resolve(fresh)})
  const pending=transform(s.environment,'id','/module.js',options,10,s.module)
  s.module.lastInvalidationTimestamp=11
  finish(original)
  assert.equal(await pending,fresh)
  assert.deepEqual(calls,[[s.environment,'/module.js',options]])
  assert.deepEqual(s.publications,[])
})
test('equal timestamps retry too, matching the original strict cache comparison',async()=>{
  const fresh={},s=state('client',10,async()=>({}))
  assert.equal(await compile(()=>fresh)(s.environment,'id','/module.js',{},10,s.module),fresh)
  assert.deepEqual(s.publications,[])
})
test('SSR keeps its existing invalidated-result behavior',async()=>{
  const result={},s=state('server',11,async()=>result)
  assert.equal(await compile(()=>assert.fail('Server transform must not retry'))(s.environment,'id','/module.js',{},10,s.module),result)
  assert.deepEqual(s.publications,[])
})
test('original load failures and retry failures survive unchanged',async()=>{
  const loadError=Error('load'),retryError=Error('retry')
  const load=state('client',11,async()=>{throw loadError})
  await assert.rejects(compile(()=>assert.fail('Failed load must not retry'))(load.environment,'id','/module.js',{},10,load.module),error=>error===loadError)
  const retry=state('client',11,async()=>({}))
  await assert.rejects(compile(()=>{throw retryError})(retry.environment,'id','/module.js',{},10,retry.module),error=>error===retryError)
})
test('missing, duplicated, changed and already-corrected upstream shapes fail closed',()=>{
  assert.throws(()=>retryInvalidatedViteClientTransform('export const value=1'),/exactly one/)
  assert.throws(()=>retryInvalidatedViteClientTransform(source+source),/already been declared|exactly one/)
  assert.throws(()=>retryInvalidatedViteClientTransform(source.replace('timestamp>','timestamp>=')),/cache guard changed/)
  assert.throws(()=>retryInvalidatedViteClientTransform(source.replace('updateModuleTransformResult','other')),/cache publication changed/)
  assert.throws(()=>retryInvalidatedViteClientTransform(retryInvalidatedViteClientTransform(source)),/already applied/)
})
test('both pinned Vite 8 toolchains accept exactly one generic client retry',()=>{
  for(const root of ['node_modules/vite8-browser','tests/fixtures/native-runtime-832/node_modules/vite']){
    const transformed=retryInvalidatedViteClientTransform(readFileSync(root+'/dist/node/chunks/node.js','utf8'))
    assert.match(transformed,/timestamp <= mod.lastInvalidationTimestamp && environment.config.consumer === "client"/)
    assert.match(transformed,/return transformRequest\(environment, url, options\)/)
  }
})
test('compiler build requires the correction and binds its source in shipped inputs',()=>{
  const build=readFileSync('scripts/build-browser-vite.mjs','utf8')
  assert.ok(build.includes('source=retryInvalidatedViteClientTransform(source)'))
  assert.ok(build.includes('invalidatedClientTransformRetryApplied!==1'))
  assert.ok(build.includes("scripts/vite-client-transform-invalidation.mjs"))
  assert.ok(build.includes('retryInvalidatedClientTransform:true'))
})
