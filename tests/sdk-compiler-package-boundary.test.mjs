import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {verifyCompilerPackageBoundary} from '../scripts/build-sdk-packages.mjs'
import {requiredDependencies} from '../src/sdk/compiler-assets.mjs'

function fixture(paths=[],dependencies=requiredDependencies){
  const root=mkdtempSync(join(tmpdir(),'compiler-package-boundary-'))
  const core=join(root,'sdk'),runtime=join(root,'runtime')
  for(const directory of [core,runtime]){
    mkdirSync(directory)
    writeFileSync(join(directory,'package-assets.json'),JSON.stringify({files:paths.map(path=>({path}))}))
  }
  writeFileSync(join(runtime,'package.json'),JSON.stringify({dependencies}))
  return [core,runtime]
}

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
