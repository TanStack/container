import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {buildSDKAPIContract} from '../scripts/sdk-api-contract.mjs'
import {compareSDKAPIContracts} from '../scripts/sdk-api-compare.mjs'
import {buildSDKTypes} from '../scripts/build-sdk-types.mjs'

test('source API 6 has distinct internal staging and public split asset contracts',()=>{
  const root=mkdtempSync(join(tmpdir(),'sdk-api-six-')),declarations=buildSDKTypes(root)
  const staging=buildSDKAPIContract(root,declarations,{requireCompatibility:true,internalStaging:true})
  assert.equal(staging.apiVersion,6)
  assert.equal(JSON.parse(readFileSync(join(root,staging.path))).scope,'internal-staging')
  assert.ok(staging.exports['./assets'].includes('copyRuntimeAssets'))
  writeFileSync(join(root,declarations.assetsEntry),readFileSync('src/sdk/package-assets.d.ts'))
  const split=buildSDKAPIContract(root,declarations,{requireCompatibility:true})
  assert.equal(split.apiVersion,6)
  assert.equal(JSON.parse(readFileSync(join(root,split.path))).scope,undefined)
  assert.ok(split.exports['./assets'].includes('prepareRuntimeAssets'))
  assert.ok(split.exports['./assets'].includes('PreviewHostHostingContract'))
  const publicAssets=JSON.parse(readFileSync(join(root,split.path))).entrypoints['./assets'].exports
  assert.match(publicAssets.find(item=>item.name==='readPreviewHostHostingContract').declarations.map(item=>item.text).join('\n'),/\): PreviewHostHostingContract/)
  assert.equal(split.exports['./assets'].includes('copyRuntimeAssets'),false)
  assert.notEqual(split.sha256,staging.sha256)
  const host=readFileSync('src/sdk/kernel-host.ts','utf8')
  assert.match(host,/import \{SDK_COMPATIBILITY,WorkerKernel\} from '\.\/index'/)
  assert.match(host,/apiVersion:SDK_COMPATIBILITY\.apiVersion/)
})

function fixture(text,extra={}){
  const root=mkdtempSync(join(tmpdir(),'sdk-api-contract-')),path='types/sdk/index.d.ts'
  mkdirSync(join(root,'types/sdk'),{recursive:true});writeFileSync(join(root,path),text)
  for(const [name,source] of Object.entries(extra))writeFileSync(join(root,'types/sdk',name),source)
const metadata=buildSDKAPIContract(root,{entry:'./'+path,assetsEntry:'./'+path,files:[path,...Object.keys(extra).map(name=>'types/sdk/'+name)]})
  return {root,metadata,contract:JSON.parse(readFileSync(join(root,metadata.path),'utf8'))}
}

test('contract is deterministic, path-clean and records exact exports',()=>{
  const left=fixture('export declare const SDK_COMPATIBILITY: { readonly apiVersion: 1; readonly stability: "experimental" };\nexport declare class WorkerKernel {}\n')
  const right=fixture('export declare const SDK_COMPATIBILITY: { readonly apiVersion: 1; readonly stability: "experimental" };\nexport declare class WorkerKernel {}\n')
  assert.equal(left.metadata.sha256,right.metadata.sha256)
  assert.deepEqual(left.metadata.exports['.'],['SDK_COMPATIBILITY','WorkerKernel'])
  assert.equal(JSON.stringify(left.contract).includes(left.root),false)
})

test('base method signature changes are detected through the exported SDK facade',()=>{
  const facade='import {Kernel} from "./kernel"; export declare class WorkerKernel extends Kernel { constructor(); }'
  const before=fixture(facade,{'kernel.d.ts':'export declare class Kernel { install(options?: object): Promise<void>; }'})
  const after=fixture(facade,{'kernel.d.ts':'export declare class Kernel { install(options?: object, signal?: AbortSignal): Promise<void>; }'})
  const exported=after.contract.entrypoints['.'].exports.find(item=>item.name==='WorkerKernel')
  assert.equal(exported.inheritedMembers[0].name,'install')
  assert.match(exported.inheritedMembers[0].type,/signal\?: AbortSignal/)
  assert.equal(exported.inheritedMembers[0].declarations[0].path,'types/sdk/kernel.d.ts')
  assert.throws(()=>compareSDKAPIContracts(before.contract,after.contract),/changed: WorkerKernel/)
  const bumped={...after.contract,apiVersion:before.contract.apiVersion+1}
  assert.deepEqual(compareSDKAPIContracts(before.contract,bumped).entrypoints['.'].changed,['WorkerKernel'])
  const repeat=fixture(facade,{'kernel.d.ts':'export declare class Kernel { install(options?: object, signal?: AbortSignal): Promise<void>; }'})
  assert.equal(after.metadata.sha256,repeat.metadata.sha256)
  assert.equal(JSON.stringify(after.contract).includes(after.root),false)
})

test('inherited API includes public static and transitive generic members but not hidden or overridden members',()=>{
  const facade='import {Base} from "./base"; export declare class WorkerKernel extends Base<string> { override(value: string): string; }'
  const base='declare class Parent<T> { value: T; protected hidden(): void; private secret; static create(value: string): void; constructor(value: T); override(value: T): T; } export declare class Base<T> extends Parent<T> {}'
  const contract=fixture(facade,{'base.d.ts':base}).contract
  const api=contract.entrypoints['.'].exports[0]
  assert.deepEqual(api.inheritedMembers.map(({name,side})=>[name,side]),[['value','instance'],['create','static']])
  assert.equal(api.inheritedMembers[0].type,'string')
  assert.deepEqual(api.inheritedConstructors,['(value: string): WorkerKernel'])
  const hiddenChange=fixture(facade,{'base.d.ts':base.replace('private secret;','private otherSecret;').replace('hidden(): void','hidden(value: number): void')}).contract
  assert.equal(compareSDKAPIContracts(contract,hiddenChange).compatible,true)
  const staticChange=fixture(facade,{'base.d.ts':base.replace('static create(value: string)','static create(value: number)')}).contract
  assert.throws(()=>compareSDKAPIContracts(contract,staticChange),/changed: WorkerKernel/)
  const constructorChange=fixture(facade,{'base.d.ts':base.replace('constructor(value: T)','constructor(value: T, flag?: boolean)')}).contract
  assert.throws(()=>compareSDKAPIContracts(contract,constructorChange),/changed: WorkerKernel/)
})

test('same apiVersion accepts additions and rejects removals or signature changes',()=>{
  const baseline=fixture('export declare function run(value: string): string;\n').contract
  const added=fixture('export declare function run(value: string): string;\nexport declare const extra: true;\n').contract
  assert.deepEqual(compareSDKAPIContracts(baseline,added).entrypoints['.'].added,['extra'])
  const removed=fixture('export {};\n').contract
  assert.throws(()=>compareSDKAPIContracts(baseline,removed),/new apiVersion/)
  const changed=fixture('export declare function run(value: number): string;\n').contract
  assert.throws(()=>compareSDKAPIContracts(baseline,changed),/changed: run/)
})
