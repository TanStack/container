import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,lstatSync,readdirSync} from 'node:fs'
import {basename,join,resolve} from 'node:path'
import {isAlphaSDKVersion} from './sdk-license-policy.mjs'
import {verifyDeploymentAssets} from './sdk-external-assets.mjs'

const names={sdk:'@tanstack/browser-sandbox-experimental',runtime:'@tanstack/browser-sandbox-runtime-experimental'}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const safe=path=>typeof path==='string'&&!path.startsWith('/')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!/[\\\r\n]/.test(path)
const exact=(object,keys)=>assert.deepEqual(Object.keys(object??{}).sort(),keys.sort(),'Unexpected schema fields')
const https=value=>{const url=new URL(value);assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');return url.href}

function inspectPackage(directory,tarball,role,sourceLicense){
  assert.ok(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink(),'Package root must be a real directory')
  const manifestBytes=readFileSync(join(directory,'package-assets.json'))
  const manifest=JSON.parse(manifestBytes)
  exact(manifest,['format','files']);assert.equal(manifest.format,1)
  assert.ok(Array.isArray(manifest.files))
  const files=new Map([['package-assets.json',manifestBytes]])
  for(const item of manifest.files){
    exact(item,['path','bytes','sha256'])
    assert.ok(safe(item.path)&&!files.has(item.path),'Unsafe or duplicate package path')
    assert.ok(Number.isSafeInteger(item.bytes)&&item.bytes>=0)
    assert.match(item.sha256,/^[a-f0-9]{64}$/)
    const bytes=readFileSync(join(directory,item.path))
    assert.equal(bytes.length,item.bytes);assert.equal(sha(bytes),item.sha256,'Package asset hash mismatch')
    files.set(item.path,bytes)
  }
  const found=[]
  function walk(relative=''){
    for(const name of readdirSync(join(directory,relative))){
      const path=relative?relative+'/'+name:name,stat=lstatSync(join(directory,path))
      assert.ok(safe(path)&&!stat.isSymbolicLink(),'Unsafe package entry')
      if(stat.isDirectory())walk(path)
      else {assert.ok(stat.isFile());found.push(path)}
    }
  }
  walk();assert.deepEqual(found.sort(),[...files.keys()].sort(),'Package inventory mismatch')
  const pkg=JSON.parse(files.get('package.json'))
  assert.equal(pkg.name,names[role]);assert.equal(pkg.private,false,'Package must explicitly be nonprivate')
  assert.ok(isAlphaSDKVersion(pkg.version),'Package must have an alpha version');assert.equal(pkg.license,'MIT')
  assert.equal(pkg.publishConfig?.access,'public')
  assert.ok(files.has('LICENSE'),'Package must include its root LICENSE: '+role)
  assert.ok(files.get('LICENSE').equals(sourceLicense),'Package LICENSE differs from the source archive: '+role)
  const run=args=>{const result=spawnSync('tar',args,{maxBuffer:64*1024*1024});assert.equal(result.status,0,'Cannot inspect tarball');return result.stdout}
  const types=run(['-tvzf',tarball]).toString().trim().split('\n')
  assert.ok(types.every(line=>line.startsWith('-')||line.startsWith('d')),'Tarball contains links or special entries')
  const entries=run(['-tzf',tarball]).toString().split('\n').filter(Boolean)
  for(const path of entries)assert.ok(path.startsWith('package/')&&safe(path.endsWith('/')?path.slice(0,-1):path),'Unsafe tarball path')
  const packed=entries.filter(path=>!path.endsWith('/'))
  assert.deepEqual(packed.sort(),[...files.keys()].map(path=>'package/'+path).sort(),'Tarball inventory mismatch')
  for(const[path,bytes]of files)assert.ok(run(['-xOzf',tarball,'package/'+path]).equals(bytes),'Packed bytes differ: '+path)
  return {pkg,manifestSHA256:sha(manifestBytes),tarballBytes:readFileSync(tarball)}
}

// This verifies publication identity, not workflow acceptance. The caller must
// supply the hash of an independently reviewed acceptance record.
export function createSplitSDKPublicationAttestation({sdk,runtime,releaseRecord,sourceArchive,acceptanceRecord,expectedAcceptanceSHA256,deploymentDirectory,registry,distTag}){
  exact(releaseRecord,['format','status','source','packages','acceptanceSHA256','deploymentManifestSHA256'])
  assert.equal(releaseRecord.format,1);assert.equal(releaseRecord.status,'approved-split-candidate')
  assert.match(expectedAcceptanceSHA256??'',/^[a-f0-9]{64}$/,'Reviewed acceptance hash is required')
  assert.equal(sha(readFileSync(acceptanceRecord)),expectedAcceptanceSHA256,'Acceptance bytes differ from reviewed evidence')
  assert.equal(releaseRecord.acceptanceSHA256,expectedAcceptanceSHA256)
  const sourceBytes=readFileSync(sourceArchive)
  assert.deepEqual(releaseRecord.source,{kind:'source-archive',revision:'sha256:'+sha(sourceBytes),archive:{file:basename(sourceArchive),bytes:sourceBytes.length,sha256:sha(sourceBytes)}})
  // Read the exact root license from our bound source archive, without
  // extracting files or following archive links on the host filesystem.
  const sourceEntry='web-container-source/LICENSE'
  const sourceTar=args=>{
    const result=spawnSync('tar',args,{maxBuffer:64*1024*1024})
    assert.equal(result.status,0,'Cannot inspect source archive LICENSE')
    return result.stdout
  }
  const sourceEntries=sourceTar(['-tzf',sourceArchive]).toString().split('\n').filter(Boolean)
  assert.equal(sourceEntries.filter(path=>path===sourceEntry).length,1,'Source archive must contain one root LICENSE')
  const sourceTypes=sourceTar(['-tvzf',sourceArchive,sourceEntry]).toString().trim().split('\n')
  assert.ok(sourceTypes.length===1&&sourceTypes[0].startsWith('-'),'Source archive LICENSE must be a regular file')
  const sourceLicense=sourceTar(['-xOzf',sourceArchive,sourceEntry])
  assert.ok(sourceLicense.length>0,'Source archive LICENSE must not be empty')
  exact(releaseRecord.packages,['sdk','runtime'])
  const inspected={sdk:inspectPackage(resolve(sdk.directory),sdk.tarball,'sdk',sourceLicense),runtime:inspectPackage(resolve(runtime.directory),runtime.tarball,'runtime',sourceLicense)}
  assert.equal(inspected.sdk.pkg.version,inspected.runtime.pkg.version,'Package versions must match')
  assert.equal(inspected.sdk.pkg.dependencies?.[names.runtime],inspected.runtime.pkg.version,'Runtime dependency must be exactly pinned')
  const registryURL=https(registry)
  assert.ok(typeof distTag==='string'&&/^[a-z][a-z0-9-]*$/.test(distTag),'Explicit dist-tag required')
  const packages={}
  for(const role of ['sdk','runtime']){
    const {pkg,manifestSHA256,tarballBytes}=inspected[role]
    const identity={name:pkg.name,version:pkg.version,private:false,license:'MIT',publishAccess:'public',manifestSHA256,tarballSHA256:sha(tarballBytes)}
    assert.deepEqual(releaseRecord.packages[role],identity,'Release identity mismatch')
    const metadata=({sdk,runtime})[role].registryMetadata
    assert.equal(metadata?.name,pkg.name)
    const published=metadata.versions?.[pkg.version]
    assert.ok(published,'Published version missing')
    for(const field of ['name','version','license'])assert.equal(published[field],pkg[field],'Registry identity mismatch')
    assert.notEqual(published.private,true)
    assert.deepEqual(published.dependencies??{},pkg.dependencies??{},'Registry dependencies differ')
    assert.equal(metadata['dist-tags']?.[distTag],pkg.version,'Registry dist-tag mismatch')
    const integrity='sha512-'+createHash('sha512').update(tarballBytes).digest('base64')
    assert.equal(published.dist?.integrity,integrity,'Registry integrity mismatch')
    packages[role]={...identity,publication:{tarball:https(published.dist.tarball),integrity,integrityVerified:true}}
  }
  const deploymentBytes=readFileSync(join(deploymentDirectory,'deployment-manifest.json'))
  assert.equal(sha(deploymentBytes),releaseRecord.deploymentManifestSHA256,'Deployment evidence mismatch')
  const deployment=JSON.parse(deploymentBytes)
  verifyDeploymentAssets(deploymentDirectory,deployment,{packageManifestSHA256:inspected.runtime.manifestSHA256,expectedFiles:deployment.files})
  return {format:1,status:'published',source:releaseRecord.source,packages,acceptanceSHA256:expectedAcceptanceSHA256,deploymentManifestSHA256:sha(deploymentBytes),registry:registryURL,distTag}
}
