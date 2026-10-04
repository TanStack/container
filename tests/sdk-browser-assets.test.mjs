import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {sdkBrowserAssets} from '../scripts/sdk-browser-assets.mjs'

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sdk-browser-assets-test-'))
  const files=['index.js','native-chunks/index-Abc_123.js','sdk-chunks/worker-Abc_123.js','assets.mjs','types/sdk/native.d.ts']
    .map(path=>{mkdirSync(join(root,path,'..'),{recursive:true});const bytes='export {}';writeFileSync(join(root,path),bytes)
      return {path,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')}})
  writeFileSync(join(root,'package-assets.json'),JSON.stringify({format:1,files}))
  return root
}

test('SDK browser hosting preserves both native and historical chunk URLs',()=>{
  const root=fixture(),assets=sdkBrowserAssets(root)
  assert.deepEqual([...assets.keys()],['/sdk/index.js','/sdk/native-chunks/index-Abc_123.js','/sdk/sdk-chunks/worker-Abc_123.js'])
  assert.equal(assets.get('/sdk/native-chunks/index-Abc_123.js'),join(root,'native-chunks/index-Abc_123.js'))
  assert.equal(assets.has('/sdk/assets.mjs'),false)
  assert.equal(assets.has('/sdk/types/sdk/native.d.ts'),false)
})

test('changed browser modules cannot be served under the recorded package identity',()=>{
  const root=fixture()
  writeFileSync(join(root,'native-chunks/index-Abc_123.js'),'changed')
  assert.throws(()=>sdkBrowserAssets(root),/size mismatch|hash mismatch/)
})
