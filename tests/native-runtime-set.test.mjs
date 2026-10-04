import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {copyNativeRuntime,copyNativeRuntimeSet} from '../scripts/native-runtime-assets.mjs'
import {verifyNativeRuntime} from '../scripts/verify-sdk.mjs'

function fixture(root,name,vite,rolldown){
  const directory=join(root,name)
  mkdirSync(directory)
  for(const path of ['engine.js','filesystem-owner.mjs','esbuild.wasm','rolldown-binding.wasm32-wasi.wasm',
    'lightningcss_node.wasm','lightningcss-1.32.0.wasm','oxide/oxide.mjs',
    'oxide/tailwindcss-oxide.wasm32-wasi.wasm']){
    mkdirSync(dirname(join(directory,path)),{recursive:true})
    writeFileSync(join(directory,path),name+':'+path)
  }
  const packages=[{name:'vite',version:vite},{name:'@rolldown/browser',version:rolldown},
    {name:'esbuild-wasm',version:'0.28.2'}].map(item=>({...item,noticeTextPresent:true}))
  writeFileSync(join(directory,'SHIPPED-INPUTS.json'),JSON.stringify({format:1,
    toolchain:{vite,rolldown},packages,workspaceInputs:[],missingNoticeText:[],
    noticeTextCoverageComplete:true,distributionReviewComplete:true}))
  writeFileSync(join(directory,'THIRD-PARTY-NOTICES.txt'),packages.map(item=>
    `${item.name}@${item.version}\nDeclared license: MIT\n`).join('\n'))
  return directory
}

test('distinct compiler runtimes retain their files and selection identities',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-runtime-set-test-'))
  const sources=[fixture(root,'old','8.3.1','1.2.11'),fixture(root,'new','8.3.2','1.2.12')]
  const target=join(root,'output')
  const runtimes=copyNativeRuntimeSet(sources,target,{publicationCandidate:true})
  assert.deepEqual(runtimes.map(runtime=>runtime.toolchain),[
    {vite:'8.3.1',rolldown:'1.2.11'},{vite:'8.3.2',rolldown:'1.2.12'}])
  for(const [index,runtime] of runtimes.entries()){
    assert.equal(runtime.entry,`runtime/native/${runtime.id}/engine.js`)
    for(const file of runtime.files)
      assert.deepEqual(readFileSync(join(target,runtime.id,file.path)),readFileSync(join(sources[index],file.path)))
  }
  assert.throws(()=>copyNativeRuntimeSet(sources,target),/must be new/)
})

test('ambiguous or invalid runtime sets reject before creating a destination',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-runtime-set-test-'))
  const source=fixture(root,'old','8.3.1','1.2.11')
  const target=join(root,'output')
  assert.throws(()=>copyNativeRuntimeSet([],target),/nonempty/)
  assert.throws(()=>copyNativeRuntimeSet([source,source],target),/Duplicate native runtime/)
  assert.equal(existsSync(target),false)
  const path=join(source,'SHIPPED-INPUTS.json')
  const inventory=JSON.parse(readFileSync(path,'utf8'))
  inventory.toolchain.vite='8.3.2'
  writeFileSync(path,JSON.stringify(inventory))
  assert.throws(()=>copyNativeRuntimeSet([source],target),/conflicts with package inventory/)
  assert.equal(existsSync(target),false)
})

test('catalog verification binds compiler identities and rejects unlisted runtime files',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-runtime-catalog-test-'))
  const sources=[fixture(root,'old','8.3.1','1.2.11'),fixture(root,'new','8.3.2','1.2.12')]
  mkdirSync(join(root,'runtime'))
  const copied=copyNativeRuntimeSet(sources,join(root,'runtime/native'))
  const runtimes=copied.map(runtime=>{
    const prefix=runtime.entry.slice(0,-'engine.js'.length)
    return {entry:runtime.entry,toolchain:runtime.toolchain,engineSHA256:runtime.engineSHA256,
      missingNoticeText:[],noticeTextCoverageComplete:true,distributionReviewComplete:true,
      externalAssets:['esbuild.wasm','rolldown-binding.wasm32-wasi.wasm'].map(name=>({
        path:prefix+name,sha256:runtime.files.find(file=>file.path===name).sha256}))}
  })
  const claim={runtimes,missingNoticeText:[],noticeTextCoverageComplete:true,distributionReviewComplete:true,
    externalAssets:runtimes.flatMap(runtime=>runtime.externalAssets)}
  const seen=new Set(copied.flatMap(runtime=>runtime.files.map(file=>runtime.entry.slice(0,-'engine.js'.length)+file.path)))
  assert.doesNotThrow(()=>verifyNativeRuntime(root,claim,seen))
  assert.throws(()=>verifyNativeRuntime(root,claim,new Set([...seen,'runtime/native/unlisted/engine.js'])),/Unlisted/)
  assert.throws(()=>verifyNativeRuntime(root,{...claim,distributionReviewComplete:false},seen),/notice summary mismatch/)
  const inventoryPath=join(root,runtimes[0].entry.slice(0,-'engine.js'.length),'SHIPPED-INPUTS.json')
  const inventory=JSON.parse(readFileSync(inventoryPath,'utf8'))
  inventory.toolchain.vite='8.3.2'
  writeFileSync(inventoryPath,JSON.stringify(inventory))
  assert.throws(()=>verifyNativeRuntime(root,claim,seen),/compiler identity mismatch/)
})

test('diagnostic runtimes remain private and reject publication before creating output',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-runtime-diagnostic-test-'))
  const source=fixture(root,'diagnostic','8.3.1','1.2.11')
  const path=join(source,'SHIPPED-INPUTS.json')
  const inventory=JSON.parse(readFileSync(path,'utf8'))
  for(const diagnostics of [{vitePrivateCallbackTrace:true},{rolldownWorkerPoolControl:4},{},null]){
    writeFileSync(path,JSON.stringify({...inventory,diagnostics}))
    for(const copy of [()=>copyNativeRuntime(source,join(root,'release'),{publicationCandidate:true}),
      ()=>copyNativeRuntimeSet([source],join(root,'release'),{publicationCandidate:true})])
      assert.throws(copy,/Diagnostic native runtimes/)
    assert.equal(existsSync(join(root,'release')),false)
  }
  writeFileSync(path,JSON.stringify({...inventory,diagnostics:{rolldownWorkerPoolControl:4}}))
  assert.deepEqual(copyNativeRuntime(source,join(root,'private')).diagnostics,{rolldownWorkerPoolControl:4})
})
