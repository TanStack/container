import assert from 'node:assert/strict'
import {readFileSync,lstatSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {compareSDKAPIContracts} from './sdk-api-compare.mjs'

const read=(root,path)=>JSON.parse(readFileSync(join(root,path),'utf8'))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
// Split inputs are explicit: compatibility includes the assets consumers deploy,
// not just the smaller npm package. This is not publication approval.
function verifiedInventory(root,filename){
  root=resolve(root)
  assert.ok(lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink(),'Inventory root must be a real directory')
  const manifest=read(root,filename),expected=new Map()
  assert.equal(manifest.format,1,'Unsupported inventory format')
  assert.ok(Array.isArray(manifest.files),'Missing inventory files')
  for(const item of manifest.files){
    assert.ok(typeof item.path==='string'&&/^[A-Za-z0-9_@./-]+$/.test(item.path)&&!item.path.startsWith('/')&&item.path.split('/').every(part=>part&&part!=='.'&&part!=='..')&&item.path!==filename,'Unsafe inventory path')
    assert.ok(!expected.has(item.path),'Duplicate inventory path')
    assert.ok(Number.isSafeInteger(item.bytes)&&item.bytes>=0&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid inventory identity')
    expected.set(item.path,item)
  }
  const found=new Set()
  function visit(prefix=''){
    for(const name of readdirSync(join(root,prefix))){
      const path=prefix?prefix+'/'+name:name,stat=lstatSync(join(root,path))
      assert.ok(!stat.isSymbolicLink(),'Inventory contains a symlink: '+path)
      if(stat.isDirectory()){visit(path);continue}
      assert.ok(stat.isFile(),'Unsupported inventory entry: '+path)
      if(path===filename)continue
      const item=expected.get(path),bytes=readFileSync(join(root,path))
      assert.ok(item&&bytes.length===item.bytes&&hash(bytes)===item.sha256,'Inventory mismatch: '+path)
      found.add(path)
    }
  }
  visit();assert.equal(found.size,expected.size,'Missing inventory file')
  return manifest
}
function releaseInput(input){
  if(typeof input==='string'){
    const root=resolve(input),manifest=read(root,'manifest.json')
    assert.notEqual(read(root,'package.json').sdkDistribution,'internal-staging','Internal staging is not a public SDK release; compare the split packages and deployment')
    return {root,manifest,packaging:'single',hosting:read(root,'preview-host/hosting.json')}
  }
  assert.ok(input&&typeof input.sdk==='string'&&typeof input.runtime==='string'&&typeof input.deployment==='string','Split release requires sdk, runtime and deployment directories')
  const root=resolve(input.sdk),runtime=resolve(input.runtime),deployment=resolve(input.deployment)
  verifiedInventory(root,'package-assets.json');verifiedInventory(runtime,'package-assets.json')
  const deployed=verifiedInventory(deployment,'deployment-manifest.json')
  assert.equal(deployed.packageManifestSHA256,hash(readFileSync(join(runtime,'package-assets.json'))),'Deployment is not bound to this runtime package')
  const corePackage=read(root,'package.json'),runtimePackage=read(runtime,'package.json')
  assert.equal(runtimePackage.name,'@tanstack/browser-sandbox-runtime-experimental','Unexpected runtime package')
  assert.ok(typeof runtimePackage.version==='string'&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(runtimePackage.version),'Runtime package needs an exact version')
  assert.equal(corePackage.version,runtimePackage.version,'SDK and runtime versions must match')
  assert.equal(corePackage.dependencies?.[runtimePackage.name],runtimePackage.version,'SDK must pin its matching runtime package')
  const policy=corePackage.sdkCompatibility?.policy,contract=corePackage.sdkCompatibility?.contract
  assert.equal(policy,'compatibility-policy.json','Unexpected compatibility policy path')
  assert.equal(contract,'api-contract.json','Unexpected API contract path')
  const api=read(root,contract)
  assert.notEqual(api.scope,'internal-staging','Split package must contain its public API contract, not the staging contract')
  assert.equal(corePackage.sdkCompatibility.apiVersion,api.apiVersion,'Package API version mismatch')
  assert.equal(corePackage.sdkCompatibility.sha256,hash(readFileSync(join(root,contract))),'Package API contract hash mismatch')
  const hosting=read(runtime,'preview-host/hosting.json')
  assert.deepEqual(read(deployment,'preview-host/hosting.json'),hosting,'Deployed hosting contract differs from runtime')
  return {root,packaging:'split',runtimePackage,hosting,manifest:{files:deployed.files,buildProfile:read(runtime,'runtime-profile.json').buildProfile,apiContract:{path:contract},compatibilityPolicy:{path:policy}}}
}
export function checkSDKRelease(baselineDirectory,candidateDirectory){
  const b=releaseInput(baselineDirectory),c=releaseInput(candidateDirectory)
  const baseline=b.root,candidate=c.root,bm=b.manifest,cm=c.manifest
  const bp=read(baseline,bm.compatibilityPolicy.path),cp=read(candidate,cm.compatibilityPolicy.path)
  assert.deepEqual(cp,bp,'Compatibility policy changed, update the release checker before releasing')
  const ba=read(baseline,bm.apiContract.path),ca=read(candidate,cm.apiContract.path)
  let apiBreaking=false,api
  try{api=compareSDKAPIContracts(ba,{...ca,apiVersion:ba.apiVersion})}catch{apiBreaking=true;api=compareSDKAPIContracts(ba,ca)}
  const bPackage=read(baseline,'package.json'),cPackage=read(candidate,'package.json')
  const exportKeys=new Set([...Object.keys(bPackage.exports??{}),...Object.keys(cPackage.exports??{})])
  const exportChanges=[]
  for(const key of [...exportKeys].sort())if(JSON.stringify(bPackage.exports?.[key])!==JSON.stringify(cPackage.exports?.[key]))exportChanges.push({key,kind:Object.hasOwn(cPackage.exports??{},key)&&!Object.hasOwn(bPackage.exports??{},key)?'additive':'breaking'})
  const runtimeExportChanges=[]
  for(const key of [...new Set([...Object.keys(b.runtimePackage?.exports??{}),...Object.keys(c.runtimePackage?.exports??{})])].sort())if(JSON.stringify(b.runtimePackage?.exports?.[key])!==JSON.stringify(c.runtimePackage?.exports?.[key]))runtimeExportChanges.push({key,kind:Object.hasOwn(c.runtimePackage?.exports??{},key)&&!Object.hasOwn(b.runtimePackage?.exports??{},key)?'additive':'breaking'})
  // Hashed worker chunks are private implementation details referenced by stable
  // entry workers. Public asset compatibility is the stable URL surface only.
  const runtimePaths=manifest=>new Set(manifest.files.filter(file=>file.path.startsWith('runtime/')&&!/\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js$/.test(file.path)).map(file=>file.path))
  const before=runtimePaths(bm),after=runtimePaths(cm),assets={added:[...after].filter(x=>!before.has(x)).sort(),removed:[...before].filter(x=>!after.has(x)).sort()}
  const hostingChanged=JSON.stringify(b.hosting)!==JSON.stringify(c.hosting)
  const profileChanged=bm.buildProfile!==cm.buildProfile
  const packagingChanged=b.packaging!==c.packaging
  const breaking=apiBreaking||exportChanges.some(x=>x.kind==='breaking')||runtimeExportChanges.some(x=>x.kind==='breaking')||assets.removed.length>0||hostingChanged||profileChanged||packagingChanged
  const bumped=ca.apiVersion>ba.apiVersion
  assert.ok(ca.apiVersion>=ba.apiVersion,'SDK apiVersion moved backwards')
  assert.equal(bumped,breaking,breaking?'Breaking SDK release requires an apiVersion bump':'Additive SDK release must not bump apiVersion')
  return {compatible:!breaking,publicationApproved:false,packagingChanged,apiVersion:{baseline:ba.apiVersion,candidate:ca.apiVersion,bumped},api,packageExports:exportChanges,runtimePackageExports:runtimeExportChanges,runtimeAssets:assets,hostingChanged,profileChanged}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),splitAt=start=>({sdk:args[start],runtime:args[start+1],deployment:args[start+2]})
  let baseline,candidate
  if(args.length===7&&args[0]==='--split'){baseline=splitAt(1);candidate=splitAt(4)}
  else if(args.length===5&&args[0]==='--from-single'){baseline=args[1];candidate=splitAt(2)}
  else{
    assert.ok(args.length===2&&!args[0].startsWith('--'),'Usage: node scripts/check-sdk-release.mjs BASELINE_SDK CANDIDATE_SDK, or --from-single BASELINE_SDK CANDIDATE_SDK CANDIDATE_RUNTIME CANDIDATE_DEPLOYMENT, or --split BASELINE_SDK BASELINE_RUNTIME BASELINE_DEPLOYMENT CANDIDATE_SDK CANDIDATE_RUNTIME CANDIDATE_DEPLOYMENT')
    ;[baseline,candidate]=args
  }
  console.log(JSON.stringify(checkSDKRelease(baseline,candidate),null,2))
}
