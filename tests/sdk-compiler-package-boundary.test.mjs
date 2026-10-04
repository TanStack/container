import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {verifyCompilerPackageBoundary,nativeCompilerDependencies} from '../scripts/build-sdk-packages.mjs'
import {requiredDependencies} from '../src/sdk/compiler-assets.mjs'

function fixture(paths=[],dependencies=requiredDependencies){
  const root=mkdtempSync(join(tmpdir(),'compiler-package-boundary-'))
  const core=join(root,'sdk'),runtime=join(root,'runtime')
  for(const directory of [core,runtime]){
    mkdirSync(directory)
    writeFileSync(join(directory,'package-assets.json'),JSON.stringify({files:paths.map(path=>({path}))}))
  }
  writeFileSync(join(runtime,'package.json'),JSON.stringify({dependencies}))
  writeFileSync(join(runtime,'runtime-profile.json'),'{}')
  return [core,runtime]
}

test('multiple compiler versions use separate exact npm aliases',()=>{
  const assets=['1.2.11','1.2.12'].map(version=>({package:'@rolldown/browser',version,
    dependency:'native-compiler-rolldown-'+version.replaceAll('.','-')}))
  const dependencies=nativeCompilerDependencies(assets)
  assert.deepEqual(dependencies,{
    'native-compiler-rolldown-1-2-11':'npm:@rolldown/browser@1.2.11',
    'native-compiler-rolldown-1-2-12':'npm:@rolldown/browser@1.2.12',
  })
  const directories=fixture([],{...requiredDependencies,...dependencies})
  writeFileSync(join(directories[1],'runtime-profile.json'),JSON.stringify({nativeRuntime:{externalAssets:assets}}))
  assert.doesNotThrow(()=>verifyCompilerPackageBoundary(...directories))
  assert.throws(()=>nativeCompilerDependencies(assets.map(asset=>({...asset,dependency:'native-compiler-shared'}))),/Conflicting/)
  assert.throws(()=>nativeCompilerDependencies([{package:'@rolldown/browser',version:'*'}]),/must be exact/)
})

test('custom engines and adapters remain distributable with npm compiler dependencies',()=>{
  assert.doesNotThrow(()=>verifyCompilerPackageBoundary(...fixture(['runtime/engines/quickjs.wasm','adapter/worker.js'])))
})

test('upstream compiler assets cannot return to package inventories',()=>{
  for(const path of ['runtime/compiler/esbuild.wasm','other/esbuild.wasm','runtime/rolldown-parser/worker.js','other/rolldown-binding.wasm32-wasi.wasm','node_modules/compiler/index.js']){
    assert.throws(()=>verifyCompilerPackageBoundary(...fixture([path])),/must remain npm dependencies/)
  }
})

test('compiler dependencies must retain their pinned versions',()=>{
  assert.throws(()=>verifyCompilerPackageBoundary(...fixture([],{})),/Missing pinned compiler dependency/)
  assert.throws(()=>verifyCompilerPackageBoundary(...fixture([],{...requiredDependencies,'esbuild-wasm':'*'})),/Missing pinned compiler dependency/)
})

test('native compiler dependency follows the recorded runtime version',()=>{
  for(const version of ['1.2.11','1.2.12']){
    const directories=fixture([],{...requiredDependencies,'@rolldown/browser':version})
    writeFileSync(join(directories[1],'runtime-profile.json'),JSON.stringify({nativeRuntime:{externalAssets:[
      {package:'@rolldown/browser',version},
    ]}}))
    assert.doesNotThrow(()=>verifyCompilerPackageBoundary(...directories))
    writeFileSync(join(directories[1],'package.json'),JSON.stringify({dependencies:{...requiredDependencies,'@rolldown/browser':'1.2.10'}}))
    assert.throws(()=>verifyCompilerPackageBoundary(...directories),/Missing pinned native compiler dependency/)
  }
})

test('native-only packages reject legacy assets and unrelated dependencies after rehashing',()=>{
  const assets=[{package:'esbuild-wasm',version:'0.28.2'}]
  function nativeFixture(paths=[],extra={}){
    const directories=fixture(paths,{...nativeCompilerDependencies(assets),...extra})
    writeFileSync(join(directories[1],'runtime-profile.json'),JSON.stringify({buildProfile:'native',nativeRuntime:{externalAssets:assets}}))
    return directories
  }
  assert.doesNotThrow(()=>verifyCompilerPackageBoundary(...nativeFixture(['runtime/native/vite-8.3.1-rolldown-1.2.11/engine.js','runtime/mvdan-shell/shell.wasm','runtime/workers/mvdan-shell.js'])))
  for(const path of ['kernel-host.js','kernel-host.html','runtime/engines/quickjs.wasm','runtime/workers/compiler.js','runtime/tls-runtime/tls.wasm'])
    assert.throws(()=>verifyCompilerPackageBoundary(...nativeFixture([path])),/legacy kernel host|unsupported runtime asset/)
  assert.throws(()=>verifyCompilerPackageBoundary(...nativeFixture([],{esbuild:'0.28.2'})),/must match its external asset catalog/)
})
