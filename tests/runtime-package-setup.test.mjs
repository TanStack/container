import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createNativeOwnerHostAssets} from '../src/sdk/native-owner-host-assets.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture({dependency=true,version='0.28.2',native=false,nativeOnly=false,extra={}}={}){
  const directory=mkdtempSync(join(tmpdir(),'runtime-setup-test-')),root=join(directory,'package')
  mkdirSync(root)
  const files={
    'runtime-package-setup.mjs':readFileSync('src/sdk/runtime-package-setup.mjs'),
    'native-runtime-paths.mjs':readFileSync('src/sdk/native-runtime-paths.mjs'),
    'compiler-assets.mjs':readFileSync('src/sdk/compiler-assets.mjs'),
    'package.json':JSON.stringify({name:'runtime-setup-test',type:'module'}),
    'compiler-config.json':JSON.stringify({compilerArtifact:{version:'0.28.2',hashes:{'esbuild.wasm':hash('fixture wasm')}}}),
    'runtime-profile.json':'{}',
    'runtime/workers/kernel.js':'export const fixture = true\n',
    'preview-host/hosting.json':JSON.stringify({separateOrigin:true}),
    'kernel-host.html':'<!doctype html>',
  }
  if(native||nativeOnly){
    const runtimes=[{vite:'8.3.1',rolldown:'1.2.11'},{vite:'8.3.2',rolldown:'1.2.12'}].map(toolchain=>({
      toolchain,entry:`runtime/native/vite-${toolchain.vite}-rolldown-${toolchain.rolldown}/engine.js`}))
    const externalAssets=runtimes.flatMap(runtime=>{
      const prefix=runtime.entry.slice(0,-'engine.js'.length)
      files[runtime.entry]='export const fixture = true'
      return [{path:prefix+'esbuild.wasm',package:'esbuild-wasm',version:'0.28.2',packagePath:'esbuild.wasm',sha256:hash('fixture wasm')},
        {path:prefix+'rolldown-binding.wasm32-wasi.wasm',package:'@rolldown/browser',version:runtime.toolchain.rolldown,
          dependency:'native-compiler-rolldown-'+runtime.toolchain.rolldown.replaceAll('.','-'),
          packagePath:'dist/rolldown-binding.wasm32-wasi.wasm',sha256:hash('rolldown '+runtime.toolchain.rolldown)}]
    })
    files['runtime-profile.json']=JSON.stringify({...(nativeOnly?{buildProfile:'native'}:{}),nativeRuntime:{runtimes,externalAssets}})
    for(const asset of externalAssets.filter(asset=>asset.package==='@rolldown/browser')){
      const pkg=join(root,'node_modules',asset.dependency)
      mkdirSync(join(pkg,'dist'),{recursive:true})
      writeFileSync(join(pkg,'package.json'),JSON.stringify({name:asset.package,version:asset.version}))
      writeFileSync(join(pkg,asset.packagePath),'rolldown '+asset.version)
    }
  }
  if(nativeOnly){
    delete files['compiler-assets.mjs'];delete files['kernel-host.html'];delete files['runtime/workers/kernel.js']
    files['compiler-config.json']=JSON.stringify({format:1,mode:'native'})
    files['runtime/workers/mvdan-shell.js']='export const fixture = true'
  }
  Object.assign(files,extra)
  for(const [name,bytes]of Object.entries(files)){mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),bytes)}
  writeFileSync(join(root,'package-assets.json'),JSON.stringify({format:1,files:Object.entries(files).map(([path,bytes])=>({path,bytes:Buffer.byteLength(bytes),sha256:hash(bytes)}))}))
  if(dependency){
    const pkg=join(root,'node_modules/esbuild-wasm');mkdirSync(pkg,{recursive:true})
    writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'esbuild-wasm',version,main:'index.js'}))
    writeFileSync(join(pkg,'index.js'),'')
    writeFileSync(join(pkg,'esbuild.wasm'),'fixture wasm')
    writeFileSync(join(pkg,'LICENSE'),'Fixture notice')
  }
  const api=await import(pathToFileURL(join(root,'runtime-package-setup.mjs')).href)
  return {root,directory,api,target:join(directory,'deployment')}
}
test('setup outputs match their deployment hashes and cannot overwrite an existing deployment',async()=>{
  const {api,target}=await fixture()
  const output=await api.prepareRuntimeAssets(target)
  const manifest=JSON.parse(readFileSync(output.manifestPath))
  for(const file of manifest.files){const bytes=readFileSync(join(target,file.path));assert.equal(bytes.length,file.bytes);assert.equal(hash(bytes),file.sha256)}
  const kernel=manifest.files.find(file=>file.path==='runtime/workers/kernel.js')
  writeFileSync(join(target,kernel.path),'changed')
  assert.notEqual(hash(readFileSync(join(target,kernel.path))),kernel.sha256)
  await assert.rejects(api.prepareRuntimeAssets(target),/EEXIST/)
  assert.equal(readFileSync(join(target,kernel.path),'utf8'),'changed')
})
test('setup resolves two aliased compilers without mixing their deployment assets',async()=>{
  const {api,target}=await fixture({native:true})
  assert.deepEqual(api.readNativeRuntimeCandidates('/assets/runtime/'),[
    {workerURL:'/assets/runtime/native/vite-8.3.1-rolldown-1.2.11/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}},
    {workerURL:'/assets/runtime/native/vite-8.3.2-rolldown-1.2.12/engine.js',toolchain:{vite:'8.3.2',rolldown:'1.2.12'}},
  ])
  for(const path of ['//elsewhere/','/runtime/../','/runtime/?x','runtime/'])
    assert.throws(()=>api.readNativeRuntimeCandidates(path),/directory path/)
  await api.prepareRuntimeAssets(target)
  for(const [vite,rolldown] of [['8.3.1','1.2.11'],['8.3.2','1.2.12']]){
    const directory=join(target,`runtime/native/vite-${vite}-rolldown-${rolldown}`)
    assert.equal(readFileSync(join(directory,'rolldown-binding.wasm32-wasi.wasm'),'utf8'),'rolldown '+rolldown)
    assert.equal(readFileSync(join(directory,'esbuild.wasm'),'utf8'),'fixture wasm')
  }
})
test('native owner setup points to workers in the prepared runtime catalog',async()=>{
  const {api,target}=await fixture({native:true})
  await api.prepareRuntimeAssets(target)
  const runtimeCandidates=api.readNativeRuntimeCandidates('/sandbox/runtime/')
  assert.equal(existsSync(join(target,'runtime/native/engine.js')),false)
  const owner=createNativeOwnerHostAssets({
    parentOrigin:'https://example.com',
    previewOrigin:'https://preview.example.com',
    workerPath:runtimeCandidates[0].workerURL,
    assetBaseURL:'/sandbox/runtime/',
    runtimeCandidates,
  })
  const script=owner.files['/__sandbox/owner.js']
  for(const candidate of runtimeCandidates){
    assert.ok(existsSync(join(target,candidate.workerURL.slice('/sandbox/'.length))))
    assert.ok(script.includes(JSON.stringify(candidate.workerURL)))
  }
  assert.ok(script.includes('workerURL: '+JSON.stringify(runtimeCandidates[0].workerURL)))
  assert.ok(script.includes('runtimeCandidates: '+JSON.stringify(runtimeCandidates)))
})
test('tampered or unlisted package files reject before destination creation',async()=>{
  for(const name of ['runtime/workers/kernel.js','unexpected.js']){
    const {api,root,target}=await fixture()
    writeFileSync(join(root,name),'changed')
    await assert.rejects(api.prepareRuntimeAssets(target),/hash mismatch|Unlisted/)
    assert.equal(existsSync(target),false)
  }
})
test('missing dependency, wrong version and changed dependency bytes fail explicitly',async()=>{
  for(const options of [{dependency:false},{version:'0.0.0'},{}]){
    const {api,root,target}=await fixture(options)
    if(!Object.keys(options).length)writeFileSync(join(root,'node_modules/esbuild-wasm/esbuild.wasm'),'changed')
    await assert.rejects(api.prepareRuntimeAssets(target),/Cannot find module|Unsupported esbuild-wasm version|hash mismatch/)
    assert.equal(existsSync(join(target,'deployment-manifest.json')),false)
  }
})
test('rejects destinations inside the runtime package and existing symlinks',async()=>{
  const {api,root,target,directory}=await fixture()
  await assert.rejects(api.prepareRuntimeAssets(join(root,'deployment')),/outside/)
  symlinkSync(directory,target)
  await assert.rejects(api.prepareRuntimeAssets(target),/EEXIST/)
})

test('native-only setup works without legacy compiler setup or a kernel host',async()=>{
  const {api,root,target}=await fixture({nativeOnly:true})
  const output=await api.prepareRuntimeAssets(target)
  assert.equal(output.kernelHostPath,undefined)
  for(const path of ['compiler-assets.mjs','kernel-host.html','runtime/compiler','runtime/workers/kernel.js'])
    assert.equal(existsSync(join(root,path))||existsSync(join(target,path)),false,path)
  assert.ok(existsSync(join(target,'runtime/workers/mvdan-shell.js')))
  assert.equal(api.readNativeRuntimeCandidates().length,2)
  assert.ok(existsSync(join(target,'runtime/native/vite-8.3.2-rolldown-1.2.12/esbuild.wasm')))
})

test('native-only setup rejects rehashed legacy assets and invalid config before creating output',async()=>{
  for(const path of ['kernel-host.html','runtime/engines/quickjs.wasm','runtime/workers/kernel.js','runtime/compiler/engine.js']){
    const {api,target}=await fixture({nativeOnly:true,extra:{[path]:'not a native asset'}})
    await assert.rejects(api.prepareRuntimeAssets(target),/legacy kernel host|unsupported runtime asset/)
    assert.equal(existsSync(target),false)
  }
  const {api,target}=await fixture({nativeOnly:true,extra:{'compiler-config.json':JSON.stringify({format:1,mode:'native',compilerArtifact:{}})}})
  await assert.rejects(api.prepareRuntimeAssets(target),/Invalid native runtime setup/)
  assert.equal(existsSync(target),false)
})

test('native-only setup rejects mismatched external compiler versions and bytes',async()=>{
  for(const version of ['0.0.0','0.28.2']){
    const {api,root,target}=await fixture({nativeOnly:true,version})
    if(version==='0.28.2')writeFileSync(join(root,'node_modules/native-compiler-rolldown-1-2-12/dist/rolldown-binding.wasm32-wasi.wasm'),'changed')
    await assert.rejects(api.prepareRuntimeAssets(target),/dependency version mismatch|dependency hash mismatch/)
    assert.equal(existsSync(join(target,'deployment-manifest.json')),false)
  }
})
