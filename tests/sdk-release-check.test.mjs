import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {checkSDKRelease} from '../scripts/check-sdk-release.mjs'
import {SDK_COMPATIBILITY_POLICY} from '../scripts/sdk-compatibility-policy.mjs'

const exported=(name,text)=>({name,flags:2,declaration:text})
function sdk({version=1,exports=[exported('run','export declare function run(): void;')],runtime=['runtime/a.wasm'],packageExports={'.':'./index.js'},hosting={scope:'/'},profile='default'}={}){
  const root=mkdtempSync(join(tmpdir(),'sdk-release-'));mkdirSync(join(root,'preview-host'));mkdirSync(join(root,'runtime'))
  const contract={format:1,apiVersion:version,stability:'experimental',entrypoints:{'.':{exports}}}
  const manifest={apiContract:{path:'api-contract.json'},compatibilityPolicy:{path:'compatibility-policy.json'},buildProfile:profile,files:runtime.map(path=>({path}))}
  writeFileSync(join(root,'api-contract.json'),JSON.stringify(contract));writeFileSync(join(root,'compatibility-policy.json'),JSON.stringify(SDK_COMPATIBILITY_POLICY))
  writeFileSync(join(root,'package.json'),JSON.stringify({exports:packageExports}));writeFileSync(join(root,'preview-host/hosting.json'),JSON.stringify(hosting));writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest))
  return root
}

test('additive SDK release passes without an apiVersion bump',()=>{
  const baseline=sdk(),candidate=sdk({exports:[exported('run','export declare function run(): void;'),exported('extra','export declare const extra: true;')],runtime:['runtime/a.wasm','runtime/b.wasm'],packageExports:{'.':'./index.js','./extra':'./extra.js'}})
  const result=checkSDKRelease(baseline,candidate)
  assert.equal(result.compatible,true);assert.deepEqual(result.runtimeAssets.added,['runtime/b.wasm'])
})

test('new internal staging is not accepted as a public release baseline',()=>{
  const baseline=sdk()
  writeFileSync(join(baseline,'package.json'),JSON.stringify({sdkDistribution:'internal-staging',private:true}))
  assert.throws(()=>checkSDKRelease(baseline,sdk()),/Internal staging is not a public SDK release/)
})

test('breaking SDK release requires and accepts an apiVersion bump',()=>{
  const baseline=sdk(),unbumped=sdk({exports:[]})
  assert.throws(()=>checkSDKRelease(baseline,unbumped),/requires (an? |a new )apiVersion/)
  const bumped=sdk({version:2,exports:[]})
  assert.equal(checkSDKRelease(baseline,bumped).apiVersion.bumped,true)
  assert.throws(()=>checkSDKRelease(baseline,sdk({version:2})),/must not bump apiVersion/)
})

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function inventory(root,name='package-assets.json',extra={}){
  const files=[]
  function visit(prefix=''){for(const entry of readdirSync(join(root,prefix))){
    const path=prefix?prefix+'/'+entry:entry
    if(path===name)continue
    if(statSync(join(root,path)).isDirectory())visit(path)
    else{const bytes=readFileSync(join(root,path));files.push({path,bytes:bytes.length,sha256:hash(bytes)})}
  }}
  visit();writeFileSync(join(root,name),JSON.stringify({format:1,...extra,files}))
}
function split({version=1,assets=['runtime/a.wasm'],runtimeExports={'./setup':{node:'./setup.mjs'}}}={}){
  const root=mkdtempSync(join(tmpdir(),'sdk-split-release-'))
  const result={sdk:join(root,'sdk'),runtime:join(root,'runtime'),deployment:join(root,'deployed')}
  for(const directory of Object.values(result))mkdirSync(directory)
  const contract={format:1,apiVersion:version,stability:'experimental',entrypoints:{'.':{exports:[exported('run','export declare function run(): void;')]}}}
  const write=(root,path,value)=>writeFileSync(join(root,path),JSON.stringify(value))
  write(result.sdk,'api-contract.json',contract)
  write(result.sdk,'compatibility-policy.json',SDK_COMPATIBILITY_POLICY)
  write(result.sdk,'package.json',{version:'0.0.0',exports:{'.':'./index.js'},dependencies:{'@tanstack/browser-sandbox-runtime-experimental':'0.0.0'},sdkCompatibility:{apiVersion:version,policy:'compatibility-policy.json',contract:'api-contract.json',sha256:hash(readFileSync(join(result.sdk,'api-contract.json')))}})
  write(result.runtime,'package.json',{name:'@tanstack/browser-sandbox-runtime-experimental',version:'0.0.0',exports:runtimeExports})
  write(result.runtime,'runtime-profile.json',{buildProfile:'default'})
  for(const directory of [result.runtime,result.deployment]){mkdirSync(join(directory,'preview-host'));write(directory,'preview-host/hosting.json',{scope:'/'})}
  mkdirSync(join(result.deployment,'runtime'))
  for(const path of assets)writeFileSync(join(result.deployment,path),'fixture')
  inventory(result.sdk);inventory(result.runtime)
  inventory(result.deployment,'deployment-manifest.json',{packageManifestSHA256:hash(readFileSync(join(result.runtime,'package-assets.json')))})
  return result
}

test('split compatibility requires a version bump for the packaging transition',()=>{
  assert.throws(()=>checkSDKRelease(sdk(),split()),/requires an apiVersion bump/)
  const result=checkSDKRelease(sdk(),split({version:2}))
  assert.equal(result.packagingChanged,true)
  assert.equal(result.publicationApproved,false)
  assert.equal(result.apiVersion.bumped,true)
})

test('split assets API changes require a version bump even without another packaging transition',()=>{
  const baseline=split(),candidate=split()
  const setAssets=(root,version,declaration)=>{
    const path=join(root.sdk,'api-contract.json'),contract=JSON.parse(readFileSync(path))
    contract.apiVersion=version
    contract.entrypoints['./assets']={exports:[exported('prepareRuntimeAssets',declaration)]}
    writeFileSync(path,JSON.stringify(contract))
    const packagePath=join(root.sdk,'package.json'),pkg=JSON.parse(readFileSync(packagePath))
    pkg.sdkCompatibility.apiVersion=version;pkg.sdkCompatibility.sha256=hash(readFileSync(path))
    writeFileSync(packagePath,JSON.stringify(pkg));inventory(root.sdk)
  }
  setAssets(baseline,1,'export declare function prepareRuntimeAssets(path: string): string;')
  setAssets(candidate,1,'export declare function prepareRuntimeAssets(path: string): Promise<string>;')
  assert.throws(()=>checkSDKRelease(baseline,candidate),/requires a new apiVersion/)
  setAssets(candidate,2,'export declare function prepareRuntimeAssets(path: string): Promise<string>;')
  assert.equal(checkSDKRelease(baseline,candidate).apiVersion.bumped,true)
})

test('split compatibility compares deployed assets and runtime exports',()=>{
  const baseline=split()
  assert.equal(checkSDKRelease(baseline,split({assets:['runtime/a.wasm','runtime/b.wasm']})).compatible,true)
  assert.throws(()=>checkSDKRelease(baseline,split({assets:[]})),/requires an apiVersion bump/)
  assert.throws(()=>checkSDKRelease(baseline,split({runtimeExports:{}})),/requires an apiVersion bump/)
  assert.equal(checkSDKRelease(baseline,split({version:2,runtimeExports:{}})).compatible,false)
})

test('split compatibility rejects missing deployment, tampered bytes and mismatched binding',()=>{
  assert.throws(()=>checkSDKRelease(sdk(),{sdk:'x',runtime:'y'}),/deployment directories/)
  const tampered=split()
  writeFileSync(join(tampered.deployment,'runtime/a.wasm'),'changed')
  assert.throws(()=>checkSDKRelease(sdk(),tampered),/Inventory mismatch/)
  const mismatched=split()
  inventory(mismatched.deployment,'deployment-manifest.json',{packageManifestSHA256:'a'.repeat(64)})
  assert.throws(()=>checkSDKRelease(sdk(),mismatched),/not bound/)
})

test('split compatibility requires exact package pairing and contract metadata',()=>{
  const candidate=split(),path=join(candidate.sdk,'package.json'),pkg=JSON.parse(readFileSync(path))
  pkg.dependencies['@tanstack/browser-sandbox-runtime-experimental']='^0.0.0'
  writeFileSync(path,JSON.stringify(pkg));inventory(candidate.sdk)
  assert.throws(()=>checkSDKRelease(sdk(),candidate),/pin its matching/)
  pkg.dependencies['@tanstack/browser-sandbox-runtime-experimental']='0.0.0';pkg.sdkCompatibility.apiVersion=99
  writeFileSync(path,JSON.stringify(pkg));inventory(candidate.sdk)
  assert.throws(()=>checkSDKRelease(sdk(),candidate),/API version mismatch/)
})
