import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {basename,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isAlphaSDKVersion,isSupportedSDKLicense} from './sdk-license-policy.mjs'

const packageName='@tanstack/browser-sandbox-experimental'
const hash=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest(algorithm==='sha512'?'base64':'hex')

function archiveFile(tarball,path,{spawn=spawnSync}={}){
  const listed=spawn('tar',['-tzf',tarball],{encoding:'utf8'})
  if(listed.status!==0)throw Error(`Cannot inspect publication tarball\n${listed.stderr??''}`)
  const entries=listed.stdout.split('\n').filter(Boolean)
  assert.equal(entries.filter(entry=>entry===path).length,1,`Publication tarball must contain exactly one ${path}`)
  const extracted=spawn('tar',['-xOzf',tarball,path],{encoding:null,maxBuffer:16*1024*1024})
  if(extracted.status!==0)throw Error(`Cannot read ${path} from publication tarball\n${extracted.stderr?.toString()??''}`)
  return extracted.stdout
}

function registryURL(value){
  const url=new URL(value)
  assert.equal(url.protocol,'https:','Publication registry must use HTTPS')
  url.hash='';url.search=''
  if(!url.pathname.endsWith('/'))url.pathname+='/'
  return url.href
}

export function createSDKPublicationAttestation(directory,tarballPath,registryMetadata,{registry,distTag,sourceArchive,spawn=spawnSync}={}){
  const sdk=realpathSync(resolve(directory)),tarball=realpathSync(resolve(tarballPath))
  const packageBytes=readFileSync(join(sdk,'package.json')),manifestBytes=readFileSync(join(sdk,'manifest.json'))
  const packageJSON=JSON.parse(packageBytes),manifest=JSON.parse(manifestBytes)
  const release=JSON.parse(readFileSync(join(sdk,'release-record.json'),'utf8'))
  assert.equal(packageJSON.name,packageName,'Unexpected SDK package name')
  assert.notEqual(packageJSON.private,true,'Private SDK candidates cannot be attested as published')
  assert.ok(isAlphaSDKVersion(packageJSON.version),'Published SDK version must be an alpha semantic version')
  assert.ok(isSupportedSDKLicense(packageJSON.license),'Published SDK license must be a supported SPDX identifier')
  assert.equal(release.format,1,'Unsupported release record format')
  assert.equal(release.status,'candidate','Publication attestation requires a candidate release record')
  assert.equal(release.source?.kind,'source-archive','Publication attestation requires a source archive')
  assert.match(release.source?.revision??'',/^sha256:[a-f0-9]{64}$/,'Publication attestation requires a SHA-256 source revision')
  assert.ok(sourceArchive,'Publication attestation requires the source archive path')
  const sourcePath=realpathSync(resolve(sourceArchive)),sourceBytes=readFileSync(sourcePath),sourceSHA256=hash('sha256',sourceBytes)
  assert.equal(release.source.revision,`sha256:${sourceSHA256}`,'Source archive revision mismatch')
  assert.deepEqual(release.source.archive,{file:basename(sourcePath),sha256:sourceSHA256,bytes:sourceBytes.length},'Source archive metadata mismatch')
  assert.deepEqual(release.package,{name:packageJSON.name,version:packageJSON.version,private:false,license:packageJSON.license,publishAccess:'public'},'Release record package identity mismatch')
  const manifestSHA256=hash('sha256',manifestBytes)
  assert.equal(release.artifact?.manifest,'manifest.json','Release record must identify manifest.json')
  assert.equal(release.artifact.manifestSHA256,manifestSHA256,'Release record manifest hash mismatch')
  assert.equal(manifest.projectLicense?.spdx,packageJSON.license,'Manifest and package licenses differ')

  const packedPackage=JSON.parse(archiveFile(tarball,'package/package.json',{spawn}))
  const packedManifest=archiveFile(tarball,'package/manifest.json',{spawn})
  assert.equal(hash('sha256',packedManifest),manifestSHA256,'Packed manifest differs from the final manifest')
  for(const field of ['name','version','license'])assert.equal(packedPackage[field],packageJSON[field],`Packed package ${field} differs from the final package`)

  assert.ok(registryMetadata&&typeof registryMetadata==='object','Registry metadata is required after publication')
  const version=registryMetadata.versions?.[packageJSON.version]
  assert.ok(version,'Registry metadata does not contain the published version')
  assert.equal(registryMetadata.name,packageJSON.name,'Registry package name differs from the final package')
  for(const field of ['name','version','license'])assert.equal(version[field],packageJSON[field],`Registry ${field} differs from the final package`)
  assert.ok(typeof distTag==='string'&&distTag.length>0,'An explicit dist-tag is required')
  assert.equal(registryMetadata['dist-tags']?.[distTag],packageJSON.version,'Registry dist-tag does not select the published version')
  const tarballBytes=readFileSync(tarball),tarballSHA256=hash('sha256',tarballBytes)
  const integrity='sha512-'+hash('sha512',tarballBytes)
  assert.equal(version.dist?.integrity,integrity,'Registry integrity does not match the publication tarball')
  assert.doesNotThrow(()=>new URL(version.dist.tarball),'Registry tarball URL is invalid')

  return {
    format:1,status:'published',
    source:{...release.source,archiveVerified:true},
    package:{name:packageJSON.name,version:packageJSON.version,license:packageJSON.license},
    artifact:{manifest:'manifest.json',manifestSHA256,tarballSHA256},
    publication:{registry:registryURL(registry),distTag,tarball:version.dist.tarball,integrity,integrityVerified:true},
  }
}

const invoked=process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)
if(invoked){
  assert.equal(process.argv.length,6,'Usage: node scripts/sdk-publication-attestation.mjs SDK_DIRECTORY TARBALL REGISTRY_METADATA OUTPUT')
  const metadata=JSON.parse(readFileSync(resolve(process.argv[4]),'utf8'))
  const attestation=createSDKPublicationAttestation(process.argv[2],process.argv[3],metadata,{registry:process.env.SDK_PUBLICATION_REGISTRY,distTag:process.env.SDK_PUBLICATION_DIST_TAG,sourceArchive:process.env.SDK_SOURCE_ARCHIVE})
  writeFileSync(resolve(process.argv[5]),JSON.stringify(attestation,null,2)+'\n',{flag:'wx'})
}
