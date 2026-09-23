import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {writeFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
test('exact Vite descriptor and owned resolver callback match native results',()=>{
  const run=spawnSync(process.execPath,[resolve('tests/fixtures/rolldown-native-probe/resolve-reference.mjs')],{encoding:'utf8',timeout:15000})
  assert.equal(run.status,0,run.stderr)
  const evidence=JSON.parse(run.stdout)
  assert.deepEqual(evidence.versions,{vite:'8.3.0',rolldown:'1.2.9'})
  assert.equal(evidence.results.length,5)
  assert.equal(evidence.descriptor.__name,'builtin:vite-resolve')
  assert.ok(evidence.hooks.includes('resolveId'))
  assert.equal(evidence.order,null)
  assert.equal(evidence.fixtureTrace.length,1)
  assert.equal(evidence.fixtureTrace[0].value,'./imported.js')
  assert.equal(evidence.server.descriptor.options.environmentConsumer,'server')
  assert.equal(evidence.server.descriptor.options.environmentName,'ssr')
  assert.equal(evidence.server.results.length,7)
  assert.deepEqual(evidence.server.results.filter(item=>item.name.includes('builtin')).map(item=>item.result),[{id:'node:fs',external:true,moduleSideEffects:false},{id:'fs',external:true,moduleSideEffects:false}])
  assert.deepEqual(evidence.server.fixtureTrace,evidence.server.trace.filter(item=>item.name==='resolveSubpathImports').map(({name,args,value})=>({name,args,value})))
  assert.equal(evidence.update.descriptor.options.disableCache,false)
  assert.deepEqual(evidence.update.case.event,{event:'update'})
  // Preserve the observed limitation instead of treating this as an invalidation pass.
  assert.equal(evidence.update.changed,false)
  assert.deepEqual(evidence.update.afterWrite,evidence.update.before)
  assert.deepEqual(evidence.update.afterWatch,evidence.update.before)
  assert.equal(evidence.uncachedUpdate.changed,true)
  for(const profile of ['client','server']){
    assert.equal(evidence.updates[profile].before.id,join(evidence.project,evidence.update.case.before))
    assert.equal(evidence.updates[profile].after.id,join(evidence.project,evidence.update.case.after))
  }
  assert.ok(existsSync(join(evidence.project,'node_modules/linked')))
  writeFileSync(join(evidence.project,'reference-evidence.json'),JSON.stringify(evidence,null,2)+'\n')
  console.log('REFERENCE_EVIDENCE='+join(evidence.project,'reference-evidence.json'))
})
