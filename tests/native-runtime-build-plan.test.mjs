import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {nativeRuntimeBuildPlan,inspectNativeRuntimeBuild} from '../scripts/native-runtime-build-plan.mjs'
import {buildNativeRuntimeCatalog,nativeRuntimeCatalogCLIOptions} from '../scripts/build-native-runtime-catalog.mjs'

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'native-runtime-build-test-'))
  mkdirSync(join(root,'build-inputs'))
  writeFileSync(join(root,'build-inputs/native-runtime-toolchains.json'),readFileSync('build-inputs/native-runtime-toolchains.json'))
  const plan=nativeRuntimeBuildPlan(root)
  for(const item of plan)for(const [directory,name,version] of [
    [item.vitePackage,'vite',item.vite],[item.rolldownPackage,'@rolldown/browser',item.rolldown]]){
    mkdirSync(directory,{recursive:true})
    writeFileSync(join(directory,'package.json'),JSON.stringify({name,version}))
  }
  return {root,plan}
}
function emitRuntime(item){
  for(const path of ['engine.js','filesystem-owner.mjs','esbuild.wasm','rolldown-binding.wasm32-wasi.wasm',
    'lightningcss_node.wasm','lightningcss-1.32.0.wasm','oxide/oxide.mjs','oxide/tailwindcss-oxide.wasm32-wasi.wasm']){
    mkdirSync(dirname(join(item.output,path)),{recursive:true})
    writeFileSync(join(item.output,path),item.id+':'+path)
  }
  const packages=[{name:'vite',version:item.vite},{name:'@rolldown/browser',version:item.rolldown},
    {name:'esbuild-wasm',version:'0.28.2'}].map(pkg=>({...pkg,noticeTextPresent:true}))
  writeFileSync(join(item.output,'SHIPPED-INPUTS.json'),JSON.stringify({format:1,
    toolchain:{vite:item.vite,rolldown:item.rolldown},packages,workspaceInputs:[],missingNoticeText:[],
    noticeTextCoverageComplete:true,distributionReviewComplete:true}))
  writeFileSync(join(item.output,'THIRD-PARTY-NOTICES.txt'),packages.map(pkg=>`${pkg.name}@${pkg.version}\nDeclared license: MIT\n`).join('\n'))
}

test('catalog CLI honors the requested destination and rejects ambiguous arguments',()=>{
  assert.deepEqual(nativeRuntimeCatalogCLIOptions([],{}),{output:undefined})
  assert.deepEqual(nativeRuntimeCatalogCLIOptions(['/scratch/catalog'],{}),{output:'/scratch/catalog'})
  assert.deepEqual(nativeRuntimeCatalogCLIOptions([],{NATIVE_RUNTIME_CATALOG_OUTPUT:'/env/catalog'}),{output:'/env/catalog'})
  assert.throws(()=>nativeRuntimeCatalogCLIOptions(['/one','/two'],{}),/Usage:/)
  assert.throws(()=>nativeRuntimeCatalogCLIOptions(['/one'],{NATIVE_RUNTIME_CATALOG_OUTPUT:'/two'}),/not both/)
})

test('release catalog builds both pinned compilers with separate package roots and outputs',()=>{
  const {root,plan}=fixture(),calls=[]
  const runtimes=buildNativeRuntimeCatalog({root,run:(command,args,options)=>{
    calls.push({command,args,options})
    if(calls.length===1){
      assert.equal(args[0],join(root,'scripts/build-native-oxide.mjs'))
      return
    }
    const item=plan[calls.length-2]
    assert.equal(options.env.NATIVE_OXIDE_BUILD_ROOT,calls[0].args[1])
    assert.equal(options.env.NATIVE_VITE_PACKAGE_ROOT,item.vitePackage)
    assert.equal(options.env.NATIVE_VITE_VERSION,item.vite)
    assert.equal(options.env.NATIVE_ROLLDOWN_PACKAGE_ROOT,item.rolldownPackage)
    assert.equal(options.env.NATIVE_ROLLDOWN_VERSION,item.rolldown)
    assert.equal(options.env.NATIVE_RUNTIME_OUTPUT,item.output)
    emitRuntime(item)
  }})
  assert.deepEqual(runtimes.map(item=>item.toolchain),[
    {vite:'8.3.1',rolldown:'1.2.11'},{vite:'8.3.2',rolldown:'1.2.12'}])
  assert.ok(calls.every(call=>call.command===process.execPath&&call.options.cwd===root))
  assert.equal(calls.length,3)
  assert.throws(()=>buildNativeRuntimeCatalog({root}),/output exists/)
})

test('all installed compiler identities are checked before starting any build',()=>{
  const {root,plan}=fixture()
  writeFileSync(join(plan[1].rolldownPackage,'package.json'),JSON.stringify({name:'@rolldown/browser',version:'1.2.11'}))
  let calls=0
  assert.throws(()=>buildNativeRuntimeCatalog({root,run:()=>calls++}),/requires @rolldown\/browser@1.2.12/)
  assert.equal(calls,0)
  assert.equal(existsSync(join(root,'public/native-runtimes')),false)
})

test('a valid runtime inventory for another compiler cannot stand in for the pinned build',()=>{
  const {root,plan}=fixture()
  emitRuntime({...plan[0],vite:'8.3.3',rolldown:'1.2.13'})
  emitRuntime(plan[1])
  assert.throws(()=>inspectNativeRuntimeBuild(plan),/does not match/)
})

test('ambiguous versions and escaping package paths reject before building',()=>{
  const {root}=fixture(),path=join(root,'build-inputs/native-runtime-toolchains.json')
  const source=JSON.parse(readFileSync(path))
  for(const bad of [
    {...source,runtimes:[]},
    {...source,runtimes:[source.runtimes[0],source.runtimes[0]]},
    {...source,runtimes:[{...source.runtimes[0],vite:'^8.3.1'}]},
    {...source,runtimes:[{...source.runtimes[0],vitePackage:'../node_modules/vite'}]},
    {...source,runtimes:[{...source.runtimes[0],vitePackage:'/node_modules/vite'}]},
  ]){
    writeFileSync(path,JSON.stringify(bad))
    assert.throws(()=>nativeRuntimeBuildPlan(root),/must be nonempty|Duplicate|must be exact|must be relative/)
  }
})
