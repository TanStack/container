import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,relative,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {addPackageNotices} from './package-notices.mjs'
import {parserNoticeInventory} from './parser-notice-inventory.mjs'
import {writeEmscriptenNotices} from './emscripten-notices.mjs'
import {writeRolldownRustNotices} from './rolldown-rust-notices.mjs'
import {writeRustWASISysrootNotices} from './rust-wasi-sysroot-notices.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function packageDirectory(id){
  const marker=sep+'node_modules'+sep,index=id.lastIndexOf(marker)
  if(index<0)return null
  const rest=id.slice(index+marker.length).split(sep),length=rest[0]?.startsWith('@')?2:1
  return id.slice(0,index+marker.length)+rest.slice(0,length).join(sep)
}
export function sdkInputRecorder(){
  const inputs=new Set()
  return {inputs,plugin:{name:'sdk-input-recorder',moduleParsed(module){if(!module.id.startsWith('\0'))inputs.add(module.id.split('?')[0])}}}
}
export function writeSDKNotices(out,projectRoot,inputIds,engines,parserRoot,projectLicense){
  const packages=new Map(),workspace=new Set()
  for(const id of [...inputIds].sort()){
    const directory=packageDirectory(id)
    if(directory){const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));addPackageNotices(packages,directory,pkg)}
    else {const path=relative(projectRoot,id).split(sep).join('/');if(path&&!path.startsWith('../'))workspace.add(path)}
  }
  const esbuild=join(projectRoot,'node_modules/esbuild-wasm')
  addPackageNotices(packages,esbuild,JSON.parse(readFileSync(join(esbuild,'package.json'),'utf8')))
  if(parserRoot)for(const name of ['rolldown','@rolldown/binding-wasm32-wasi']){
    const directory=join(parserRoot,'node_modules',name)
    addPackageNotices(packages,directory,JSON.parse(readFileSync(join(directory,'package.json'),'utf8')))
  }
  const text=[...packages.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version))
    .map(item=>`${item.name}@${item.version}\nDeclared license: ${item.license??'not declared'}\n${item.notices||'No license or notice text was present in this installed package. Distribution review remains open.'}`).join('\n\n')
  const directory=join(out,'licenses');mkdirSync(directory)
  const emscripten=writeEmscriptenNotices(directory,engines)
  const rolldownRust=parserRoot?writeRolldownRustNotices(directory):undefined
  const rustWASI=parserRoot?writeRustWASISysrootNotices(directory,{
    version:JSON.parse(readFileSync(join(parserRoot,'node_modules/@rolldown/binding-wasm32-wasi/package.json'),'utf8')).version,
    wasmSHA256:hash(readFileSync(join(parserRoot,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm'))),
  }):undefined
  if(parserRoot){
    const inventory=parserNoticeInventory(parserRoot,JSON.parse(readFileSync(join(out,'runtime/rolldown-parser/artifact.json'),'utf8')))
    writeFileSync(join(directory,'ROLLDOWN-PACKAGE-EVIDENCE.json'),JSON.stringify(inventory,null,2)+'\n')
    writeFileSync(join(directory,'ROLLDOWN-LICENSE'),readFileSync(join(parserRoot,'node_modules/rolldown/LICENSE')))
    writeFileSync(join(directory,'ROLLDOWN-THIRD-PARTY-LICENSE'),readFileSync(join(parserRoot,'node_modules/rolldown/THIRD-PARTY-LICENSE')))
  }
  writeFileSync(join(directory,'THIRD-PARTY-NOTICES.txt'),text)
  const inputs={format:1,scope:'Locally proven build inputs and shipped notices, not legal clearance',...(projectLicense?{projectLicense:{path:'LICENSE',spdx:projectLicense.spdx,sha256:hash(readFileSync(projectLicense.path))}}:{}),generatedBundles:{artifacts:['index.js','kernel-host.js','runtime/workers/'],workspace:[...workspace].sort(),packages:[...packages.keys()].sort(),notice:'licenses/THIRD-PARTY-NOTICES.txt'},native:[
    ...(parserRoot?[{artifacts:['runtime/rolldown-parser/'],source:'Pinned Rolldown native parser and WASI runtime',notices:['licenses/ROLLDOWN-LICENSE','licenses/ROLLDOWN-THIRD-PARTY-LICENSE','licenses/THIRD-PARTY-NOTICES.txt',...rolldownRust.notices,...rustWASI.notices.map(item=>item.path)],evidence:rolldownRust.path,sysrootEvidence:rustWASI.path}]:[]),
    {artifacts:['runtime/compiler/esbuild.wasm'],source:'npm:esbuild-wasm',notice:'licenses/THIRD-PARTY-NOTICES.txt'},
    {artifacts:['runtime/compiler/artifact.json','runtime/compiler/GO-LICENSE','runtime/workers/browser-compiler.js'],source:'Pinned esbuild Go WebAssembly runtime and workspace compiler adapter',notices:['runtime/compiler/GO-LICENSE','licenses/THIRD-PARTY-NOTICES.txt']},
    {artifacts:Object.keys(engines).map(slot=>'runtime/'+slot+'/'),source:'QuickJS plus quickjs-emscripten wrapper',notices:['runtime/quickjs-als/QUICKJS-LICENSE','runtime/quickjs-als/WRAPPER-LICENSE']},
    {artifacts:[...Object.keys(engines).map(slot=>'runtime/'+slot+'/'),'runtime/tls-runtime/','runtime/http2-runtime/'],source:'Emscripten 5.0.1 generated runtime, musl libc and compiler-rt',notices:emscripten.notices.map(item=>item.path),evidence:'licenses/EMSCRIPTEN-NOTICE-EVIDENCE.json'},
    {artifacts:Object.keys(engines).filter(slot=>slot.includes('-wasm')).map(slot=>'runtime/'+slot+'/'),source:'Wasm3 embedded guest interpreter',notice:'runtime/quickjs-als-wasm/WASM3-LICENSE'},
    {artifacts:['runtime/mvdan-shell/'],source:'mvdan.cc/sh/v3 plus Go WebAssembly runtime',notices:['runtime/mvdan-shell/MVDAN-LICENSE','runtime/mvdan-shell/GO-LICENSE']},
    {artifacts:['runtime/tls-runtime/'],source:'Mbed TLS',notice:'runtime/tls-runtime/LICENSE'},
    {artifacts:['runtime/http2-runtime/'],source:'nghttp2',notice:'runtime/http2-runtime/LICENSE'},
    {artifacts:['runtime/kernel-runtime/'],source:'generated Node compatibility bundle with runtime/kernel-runtime/SHIPPED-INPUTS.json provenance',notices:['runtime/kernel-runtime/THIRD-PARTY-NOTICES.txt','runtime/kernel-runtime/ZLIB-NOTICES.txt']},
    {artifacts:['runtime/vm-web-apis/'],source:'generated Web API compatibility bundle',notice:'runtime/vm-web-apis/THIRD-PARTY-NOTICES.txt'},
  ],localArtifacts:[...(projectLicense?['LICENSE']:[]),'README.md','COMPATIBILITY.md','examples/basic/','examples/frameworks/','api-contract.json','compatibility-policy.json','candidate-compatibility.json','release-record.json','assets.mjs','kernel-host.html','package.json','preview-host/','sdk-api-compare.mjs','check-sdk-release.mjs','sdk-build-profiles.mjs','sdk-license-policy.mjs','verify-sdk.mjs','size-report.json','index.d.ts','assets.d.ts','types/','licenses/']}
  if(parserRoot)inputs.distributionReview={complete:false,packageEvidence:{path:'licenses/ROLLDOWN-PACKAGE-EVIDENCE.json',sha256:hash(readFileSync(join(directory,'ROLLDOWN-PACKAGE-EVIDENCE.json')))},rustEvidence:{path:rolldownRust.path,sha256:rolldownRust.sha256,exactLinkedContents:false,coveredMissingNoticeRecords:rolldownRust.evidence.coveredMissingNoticeRecords.length,unresolvedMissingNoticeRecords:rolldownRust.evidence.unresolvedMissingNoticeRecords},rustSysrootEvidence:{path:rustWASI.path,sha256:rustWASI.sha256,exactLinkedContents:false,rustVersion:rustWASI.evidence.rust.version,target:rustWASI.evidence.rust.standardLibraryArchive.target,wasiSDK:rustWASI.evidence.rust.builder.wasiSDKVersion},missingPackageNoticeText:[...packages.values()].filter(item=>!item.notices).map(item=>item.name+'@'+item.version).sort(),unverified:['Four overinclusive Cargo inventory records still lack source notice text: '+rolldownRust.evidence.unresolvedMissingNoticeRecords.join(', ')+'.','Cargo metadata includes workspace-unified features and build dependencies, so the inventory is not proof of the exact Rust code linked into the distributed WASM artifact. Parent Rolldown and supplemental upstream notices are shipped as evidence, not assumed complete legal clearance.','Rust 1.98.1 and WASI SDK 33 notices are bound to the shipped Rolldown WASM hash, but are not proof of the exact sysroot objects linked into that binary.']}
  const json=JSON.stringify(inputs,null,2)+'\n';writeFileSync(join(directory,'SHIPPED-INPUTS.json'),json)
  return {path:'licenses/SHIPPED-INPUTS.json',sha256:hash(json),packageCount:packages.size}
}
