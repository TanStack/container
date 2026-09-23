import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {prepareStrictSplitAssets,strictSDKFile} from './sdk-frameworks/split-assets.mjs'

test('legacy strict assets do not invoke npm setup',async()=>{
  assert.equal(await prepareStrictSplitAssets('/not-accessed',undefined),undefined)
})
test('strict split routing keeps SDK and prepared runtime roots separate',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'strict-split-route-'))),sdk=join(root,'sdk'),deployment=join(root,'deployed')
  mkdirSync(sdk);mkdirSync(join(deployment,'runtime'),{recursive:true})
  writeFileSync(join(sdk,'index.js'),'sdk');writeFileSync(join(deployment,'runtime/engine.wasm'),'runtime')
  assert.equal(strictSDKFile(sdk,deployment,'index.js'),join(sdk,'index.js'))
  assert.equal(strictSDKFile(sdk,deployment,'runtime/engine.wasm'),join(deployment,'runtime/engine.wasm'))
  assert.throws(()=>strictSDKFile(sdk,deployment,'../deployed/runtime/engine.wasm'),/outside package/)
  symlinkSync(join(sdk,'index.js'),join(deployment,'runtime/escape'))
  assert.throws(()=>strictSDKFile(sdk,deployment,'runtime/escape'),/outside package/)
})
