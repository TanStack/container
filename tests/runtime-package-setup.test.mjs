import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture({dependency=true,version='0.28.2'}={}){
  const directory=mkdtempSync(join(tmpdir(),'runtime-setup-test-')),root=join(directory,'package')
  mkdirSync(root)
  const files={
    'runtime-package-setup.mjs':readFileSync('src/sdk/runtime-package-setup.mjs'),
    'compiler-assets.mjs':readFileSync('src/sdk/compiler-assets.mjs'),
    'package.json':JSON.stringify({name:'runtime-setup-test',type:'module'}),
    'compiler-config.json':JSON.stringify({compilerArtifact:{version:'0.28.2',hashes:{'esbuild.wasm':hash('fixture wasm')}}}),
    'runtime/workers/kernel.js':'export const fixture = true\n',
    'preview-host/hosting.json':JSON.stringify({separateOrigin:true}),
    'kernel-host.html':'<!doctype html>',
  }
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
