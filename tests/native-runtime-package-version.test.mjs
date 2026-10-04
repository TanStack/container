import assert from 'node:assert/strict'
import test from 'node:test'
import {nativeRuntimePackageVersion,nativeRuntimeToolchain} from '../scripts/native-runtime-assets.mjs'

test('compiler versions come from the shipped runtime inventory',()=>{
  for(const version of ['1.2.11','1.2.12'])
    assert.equal(nativeRuntimePackageVersion({packages:[{name:'@rolldown/browser',version}]},'@rolldown/browser'),version)
})

test('runtime selection identity must match the shipped compiler packages',()=>{
  const packages=[{name:'vite',version:'8.3.1'},{name:'@rolldown/browser',version:'1.2.11'}]
  const toolchain={vite:'8.3.1',rolldown:'1.2.11'}
  assert.deepEqual(nativeRuntimeToolchain({packages,toolchain}),toolchain)
  for(const invalid of [undefined,{}, {...toolchain,vite:'8.3.2'}, {...toolchain,rolldown:'1.2.12'}])
    assert.throws(()=>nativeRuntimeToolchain({packages,toolchain:invalid}),/conflicts with package inventory/)
})

test('missing, ambiguous and non-exact compiler identities reject',()=>{
  for(const packages of [[],[{name:'@rolldown/browser',version:'^1.2.12'}],
    [{name:'@rolldown/browser',version:'1.2.11'},{name:'@rolldown/browser',version:'1.2.12'}]])
    assert.throws(()=>nativeRuntimePackageVersion({packages},'@rolldown/browser'),/one exact package version/)
})
