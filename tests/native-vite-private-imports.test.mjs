import test from 'node:test'
import assert from 'node:assert/strict'
import {probeVitePrivateImports} from './fixtures/native-vite-private-imports.mjs'

function fakeServer({wrongResolution=false,closeError=false}={}) {
  let closed=0
  const createServer=async config=>{
    const virtual=config.plugins[0],root=config.root,environment={name:'ssr'}
    environment.plugins=[{name:'builtin:vite-resolve',resolveId:async()=>({id:root+'/fixture/target.js'})}]
    const claim=()=>virtual.resolveId.handler.call({environment},'#virtual')
    environment.pluginContainer={async resolveId(id){
      return {id:id==='#virtual'?claim():wrongResolution?root+'/wrong.js':root+'/fixture/target.js'}
    }}
    environment.transformRequest=async()=>{claim();return {code:'export const result = 126'}}
    return {environments:{ssr:environment},async ssrLoadModule(id){if(id.includes('?'))claim();return {result:126}},
      async close(){closed++;if(closeError)throw Error('Close failed')}}
  }
  const rolldown=async options=>{
    for(const id of ['#target','#virtual'])await options.plugins[0].resolveId(id,'/app/fixture/entry.js')
    return {async generate(){return {output:[{type:'chunk',isEntry:true,code:'export const result = 126'}]}},async close(){}}
  }
  return {createServer,rolldown,get closed(){return closed}}
}

test('the warm probe records nested bundle work and closes the server',async()=>{
  const fake=fakeServer(),rows=[]
  const result=await probeVitePrivateImports(fake.createServer,{root:'/app',rolldown:fake.rolldown,
    report:state=>rows.push(structuredClone(state))})
  assert.equal(result.passed,true);assert.equal(result.builtinMatched,true)
  assert.equal(result.resolved.length,21);assert.equal(result.evaluated,2)
  assert.equal(result.nestedClaims,2);assert.equal(result.bundleEvaluated,1)
  assert.equal(result.virtualClaims,10);assert.equal(fake.closed,1)
  assert.equal(result.events.filter(row=>row.phase==='start')[1].label,'builtin:./target.js')
  assert.equal(rows.at(-1).events.at(-1).passed,true)
})

test('cold mode starts a transform before any explicit resolver warm-up',async()=>{
  const fake=fakeServer()
  const result=await probeVitePrivateImports(fake.createServer,{root:'/app',rolldown:fake.rolldown,cold:true})
  assert.equal(result.passed,true);assert.equal(fake.closed,1)
  assert.equal(result.events.filter(row=>row.phase==='start')[1].label,'transform-entry')
  const starts=result.events.filter(row=>row.phase==='start').map(row=>row.label)
  assert.ok(starts.indexOf('nested-bundle')<starts.indexOf('concurrent-0'))
  assert.ok(starts.indexOf('concurrent-0')<starts.indexOf('relative'))
  assert.ok(starts.indexOf('relative')<starts.indexOf('builtin:#target'))
})

test('incorrect resolutions cannot pass and still close the created server',async()=>{
  const fake=fakeServer({wrongResolution:true})
  const result=await probeVitePrivateImports(fake.createServer,{root:'/app',rolldown:fake.rolldown})
  assert.equal(result.passed,false);assert.equal(result.resolved.length,0)
  assert.ok(result.failures.some(row=>row.error.includes('Unexpected pipeline resolution')))
  assert.equal(fake.closed,1)
})

test('close failures stay failures even after successful evaluation',async()=>{
  const fake=fakeServer({closeError:true})
  const result=await probeVitePrivateImports(fake.createServer,{root:'/app',rolldown:fake.rolldown})
  assert.equal(result.passed,false);assert.equal(result.evaluated,2)
  assert.ok(result.failures.some(row=>row.label==='close-server'&&row.error.includes('Close failed')))
  assert.equal(fake.closed,1)
})
