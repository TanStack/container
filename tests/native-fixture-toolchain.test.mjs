import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyFixtureToolchain} from '../scripts/native-fixture-toolchain.mjs'
test('example preflight rejects mismatched compiler versions',()=>{
  const shipped={packages:[{name:'@rolldown/browser',version:'1.2.12'},{name:'vite',version:'8.3.1'}]}
  const lock={packages:{'node_modules/rolldown':{version:'1.2.11'},'node_modules/vite':{version:'8.3.1'}}}
  assert.throws(()=>verifyFixtureToolchain(shipped,lock),/rolldown@1.2.11/)
  assert.doesNotThrow(()=>verifyFixtureToolchain(shipped,{packages:{'node_modules/rolldown':{version:'1.2.12'}}}))
  assert.throws(()=>verifyFixtureToolchain({packages:[]},lock),/available @rolldown\/browser: none/)
  assert.throws(()=>verifyFixtureToolchain({packages:[...shipped.packages,{name:'@rolldown/browser',version:'1.2.11'}]},lock),/requires one matching/)
  assert.doesNotThrow(()=>verifyFixtureToolchain({...shipped,toolchain:{rolldown:'1.2.11',vite:'8.3.1'}},lock))
  assert.throws(()=>verifyFixtureToolchain({...shipped,toolchain:{rolldown:'1.2.12',vite:'8.3.1'}},lock),/rolldown@1.2.11/)
  assert.throws(()=>verifyFixtureToolchain({...shipped,toolchain:{}},lock),/available @rolldown\/browser: none/)
})
