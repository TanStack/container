import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {verifyRolldownParser} from '../scripts/verify-sdk.mjs'
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sdk-parser-verifier-')),prefix='runtime/rolldown-parser/',seen=new Set()
  mkdirSync(join(root,prefix),{recursive:true})
  const assets={}
  for(const name of ['worker.js','pthread.js','parser.wasm']){const bytes=Buffer.from(name);writeFileSync(join(root,prefix+name),bytes);assets[name]=createHash('sha256').update(bytes).digest('hex');seen.add(prefix+name)}
  for(const name of ['ROLLDOWN-LICENSE','ROLLDOWN-THIRD-PARTY-LICENSE'])seen.add('licenses/'+name)
  const artifact={version:'1.2.9',enabledByDefault:false,operations:['parse'],requires:['crossOriginIsolated','SharedArrayBuffer'],resources:{full:{initialPages:4096,maximumPages:20480,maxWorkers:8,asyncWorkPoolSize:4},sync:{initialPages:1024,maximumPages:8192,maxWorkers:2,asyncWorkPoolSize:1},accounting:'Separate native compiler reservations, not included in the guest memory limit'},lockSHA256:'a'.repeat(64),inputs:{'@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm':assets['parser.wasm']},sources:{'workspace/parser.js':'b'.repeat(64)},assets}
  const claim={enabledByDefault:false,directory:'runtime/rolldown-parser',artifact:prefix+'artifact.json',version:artifact.version,resources:artifact.resources,assets}
  const save=()=>writeFileSync(join(root,claim.artifact),JSON.stringify(artifact));save();seen.add(claim.artifact)
  return {root,seen,artifact,claim,save}
}
function callableFixture(){
  const f=fixture()
  f.artifact.operations=['parse','callable.create','callable.resolve','callable.update','callable.dispose']
  f.artifact.callable={builtin:'builtin:vite-resolve',requiresOwnerWorkspace:true,resolveHook:'resolveId',update:{files:'existing',event:'update',hook:'watchChange'},callbacks:['resolveSubpathImports','onWarn','onDebug','finalizeBareSpecifier','finalizeOtherSpecifiers']}
  f.save();return f
}
test('accepts earlier SDKs without parser and explicit pinned parser metadata',()=>{
  verifyRolldownParser('',undefined,new Set())
  const f=fixture();verifyRolldownParser(f.root,f.claim,f.seen)
})
test('accepts explicit callable operations without claiming application acceptance',()=>{
  const f=callableFixture();verifyRolldownParser(f.root,f.claim,f.seen)
})
test('bundler inventory is experimental, complete and paired with its methods',()=>{
  const make=()=>{
    const f=callableFixture()
    f.artifact.operations.splice(3,0,'callable.invoke')
    f.artifact.operations.push('bundler.create','bundler.run','bundler.context','bundler.close')
    f.artifact.callable.invokeHooks=['load','transform']
    f.artifact.bundler={experimental:true,requiresOwnerWorkspace:true,methods:['generate','write','scan']}
    f.save();return f
  }
  const f=make();verifyRolldownParser(f.root,f.claim,f.seen)
  for(const change of [f=>delete f.artifact.bundler,f=>f.artifact.bundler.experimental=false,f=>f.artifact.bundler.requiresOwnerWorkspace=false,f=>f.artifact.bundler.methods.push('watch'),f=>f.artifact.operations.pop()]){
    const broken=make();change(broken);broken.save()
    assert.throws(()=>verifyRolldownParser(broken.root,broken.claim,broken.seen),/bundler/)
  }
  const legacy=callableFixture();legacy.artifact.bundler=f.artifact.bundler;legacy.save()
  assert.throws(()=>verifyRolldownParser(legacy.root,legacy.claim,legacy.seen),/bundler/)
})
test('accepts callable load and transform inventory while retaining earlier callable artifacts',()=>{
  const f=callableFixture()
  f.artifact.operations.splice(3,0,'callable.invoke')
  f.artifact.callable.invokeHooks=['load','transform'];f.save()
  verifyRolldownParser(f.root,f.claim,f.seen)
  for(const hooks of [[],['load'],['load','load'],['load','transform','renderChunk']]){
    f.artifact.callable.invokeHooks=hooks;f.save();assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/invoke hook inventory/)
  }
  delete f.artifact.callable.invokeHooks;f.save();assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/capability inventory/)
  const prior=callableFixture();prior.artifact.callable.invokeHooks=['load','transform'];prior.save();assert.throws(()=>verifyRolldownParser(prior.root,prior.claim,prior.seen),/capability inventory/)
})
test('validates expanded builtin inventory without changing legacy artifacts',()=>{
  const f=callableFixture()
  f.artifact.operations.splice(3,0,'callable.invoke')
  f.artifact.callable.invokeHooks=['load','transform']
  f.artifact.callable.builtins=['builtin:vite-resolve','builtin:oxc-runtime','builtin:vite-json']
  f.save();verifyRolldownParser(f.root,f.claim,f.seen)
  for(const builtins of [[],['builtin:vite-resolve'],['builtin:vite-resolve','builtin:oxc-runtime','builtin:unknown']]){
    f.artifact.callable.builtins=builtins;f.save()
    assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/builtin inventory/)
  }
})
test('rejects unsupported, partial, duplicate and mislabeled operation inventories',()=>{
  for(const operations of [[],['parse','bundle'],['parse','callable.resolve'],['parse','parse'],['parse','callable.create','callable.resolve','callable.update','callable.dispose','callable.transform']]){
    const f=callableFixture();f.artifact.operations=operations;f.save();assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/operation inventory/)
  }
  const f=callableFixture();f.artifact.operations=['parse'];f.save();assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/Parse-only/)
})
test('rejects missing or broader callable capability claims',()=>{
  for(const change of [f=>delete f.artifact.callable,f=>f.artifact.callable.builtin='*',f=>f.artifact.callable.requiresOwnerWorkspace=false,f=>f.artifact.callable.resolveHook='transform',f=>f.artifact.callable.update.files='any',f=>f.artifact.callable.update.hook='recreatePlugin',f=>f.artifact.callable.callbacks.push('arbitraryCallback')]){
    const f=callableFixture();change(f);f.save();assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/callable/)
  }
})
test('rejects native parser without opt-in metadata or enabled by default',()=>{
  const f=fixture();assert.throws(()=>verifyRolldownParser(f.root,undefined,f.seen),/opt-in/)
  f.claim.enabledByDefault=true;assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/policy/)
})
test('rejects parser byte changes, missing notices and unaccounted files',()=>{
  const f=fixture();writeFileSync(join(f.root,'runtime/rolldown-parser/worker.js'),'changed')
  assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/hash mismatch/)
  const g=fixture();g.seen.delete('licenses/ROLLDOWN-LICENSE');assert.throws(()=>verifyRolldownParser(g.root,g.claim,g.seen),/notice/)
  const h=fixture();h.seen.add('runtime/rolldown-parser/extra.js');assert.throws(()=>verifyRolldownParser(h.root,h.claim,h.seen),/Unexpected/)
})
test('rejects leaked build paths and changed resource reservation',()=>{
  const f=fixture();f.artifact.sources={'/private/tmp/build.js':'a'.repeat(64)};f.save();assert.throws(()=>verifyRolldownParser(f.root,f.claim,f.seen),/absolute path/)
  const g=fixture();g.artifact.resources.sync.maximumPages=65536;g.save();assert.throws(()=>verifyRolldownParser(g.root,g.claim,g.seen),/reservation/)
})
