import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,writeFileSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {verifyExternalAssetRequirements,verifyDeploymentAssets} from '../scripts/sdk-external-assets.mjs'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const pin={path:'runtime/compiler/esbuild.wasm',package:'esbuild-wasm',version:'0.28.2',source:'esbuild.wasm',sha256:'b1831a5c0f6cf688034fb94d0419812f165ea316a3380d3fc00a151e562d2eaf'}
const options={pinnedAssets:[pin],packageJSON:{dependencies:{'esbuild-wasm':'0.28.2'}},packagedPaths:[]}
test('external requirements require exact identities and dependency pins',()=>{
  assert.deepEqual(verifyExternalAssetRequirements({format:1,assets:[pin]},options),{assets:1})
  for(const change of [{source:'../bad'},{sha256:'a'.repeat(64)},{version:'0.28.3'},{path:'/absolute'}])assert.throws(()=>verifyExternalAssetRequirements({format:1,assets:[{...pin,...change}]},options))
  assert.throws(()=>verifyExternalAssetRequirements({format:1,assets:[pin,pin]},options))
  assert.throws(()=>verifyExternalAssetRequirements({format:1,assets:[pin]},{...options,packagedPaths:[pin.path]}))
  assert.throws(()=>verifyExternalAssetRequirements({format:1,assets:[pin]},{...options,packageJSON:{dependencies:{'esbuild-wasm':'^0.28.2'}}}))
})
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sdk-deployment-'))
  writeFileSync(join(root,'engine.wasm'),'wasm')
  const files=[{path:'engine.wasm',bytes:4,sha256:sha('wasm')}]
  const manifest={format:1,packageManifestSHA256:sha('package manifest'),files}
  return {root,manifest,options:{packageManifestSHA256:manifest.packageManifestSHA256,expectedFiles:files}}
}
test('deployment verifies exact files and package binding',()=>{
  const f=fixture()
  assert.deepEqual(verifyDeploymentAssets(f.root,f.manifest,f.options),{files:1})
  assert.throws(()=>verifyDeploymentAssets(f.root,f.manifest,{...f.options,packageManifestSHA256:sha('other')}))
  writeFileSync(join(f.root,'engine.wasm'),'evil')
  assert.throws(()=>verifyDeploymentAssets(f.root,f.manifest,f.options),/mismatch/)
})
test('deployment rejects missing, extra, unsafe and symlink entries',()=>{
  const f=fixture()
  assert.throws(()=>verifyDeploymentAssets(f.root,{...f.manifest,files:[]},f.options))
  writeFileSync(join(f.root,'extra'),'x')
  assert.throws(()=>verifyDeploymentAssets(f.root,f.manifest,f.options),/Unexpected/)
  const linked=fixture();symlinkSync(join(linked.root,'engine.wasm'),join(linked.root,'alias'))
  assert.throws(()=>verifyDeploymentAssets(linked.root,linked.manifest,linked.options),/Unsafe/)
  assert.throws(()=>verifyDeploymentAssets(f.root,{...f.manifest,files:[{...f.manifest.files[0],path:'../bad'}]},f.options))
})
