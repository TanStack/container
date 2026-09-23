import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createSDKPublicationAttestation} from '../scripts/sdk-publication-attestation.mjs'

const sha=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest(algorithm==='sha512'?'base64':'hex')
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sdk-publication-attestation-')),sdk=join(root,'sdk'),packed=join(root,'packed','package')
  mkdirSync(sdk);mkdirSync(packed,{recursive:true})
  const pkg={name:'@tanstack/browser-sandbox-experimental',version:'0.1.0-alpha.4',license:'MIT',publishConfig:{access:'public'}}
  const manifest={buildProfile:'sync-o2',projectLicense:{path:'LICENSE',spdx:'MIT',sha256:'0'.repeat(64)}}
  const manifestText=JSON.stringify(manifest)+'\n',manifestSHA256=sha('sha256',manifestText)
  for(const directory of [sdk,packed]){
    writeFileSync(join(directory,'package.json'),JSON.stringify(pkg)+'\n')
    writeFileSync(join(directory,'manifest.json'),manifestText)
  }
  const sourceArchive=join(root,'web-container-source.tar.gz'),sourceBytes=Buffer.from('source archive fixture'),sourceSHA256=sha('sha256',sourceBytes)
  writeFileSync(sourceArchive,sourceBytes)
  writeFileSync(join(sdk,'release-record.json'),JSON.stringify({format:1,status:'candidate',package:{name:pkg.name,version:pkg.version,private:false,license:'MIT',publishAccess:'public'},artifact:{manifest:'manifest.json',manifestSHA256},source:{kind:'source-archive',revision:`sha256:${sourceSHA256}`,archive:{file:'web-container-source.tar.gz',sha256:sourceSHA256,bytes:sourceBytes.length}}}))
  const tarball=join(root,'package.tgz'),packedRoot=join(root,'packed')
  assert.equal(spawnSync('tar',['-czf',tarball,'-C',packedRoot,'package']).status,0)
  const bytes=readFileSync(tarball),integrity='sha512-'+sha('sha512',bytes)
  const metadata={name:pkg.name,'dist-tags':{alpha:pkg.version},versions:{[pkg.version]:{name:pkg.name,version:pkg.version,license:'MIT',dist:{integrity,tarball:'https://registry.example.test/pkg.tgz'}}}}
  return {sdk,tarball,metadata,sourceArchive,sourceSHA256,manifestSHA256,tarballSHA256:sha('sha256',bytes),integrity}
}

test('binds the final package, source, manifest, tarball and registry result',()=>{
  const value=fixture()
  const result=createSDKPublicationAttestation(value.sdk,value.tarball,value.metadata,{registry:'https://registry.example.test',distTag:'alpha',sourceArchive:value.sourceArchive})
  assert.deepEqual(result.source,{kind:'source-archive',revision:`sha256:${value.sourceSHA256}`,archive:{file:'web-container-source.tar.gz',sha256:value.sourceSHA256,bytes:22},archiveVerified:true})
  assert.deepEqual(result.artifact,{manifest:'manifest.json',manifestSHA256:value.manifestSHA256,tarballSHA256:value.tarballSHA256})
  assert.deepEqual(result.publication,{registry:'https://registry.example.test/',distTag:'alpha',tarball:'https://registry.example.test/pkg.tgz',integrity:value.integrity,integrityVerified:true})
})

test('fails closed when any publication binding differs',()=>{
  const value=fixture()
  value.metadata.versions['0.1.0-alpha.4'].dist.integrity='sha512-bad'
  assert.throws(()=>createSDKPublicationAttestation(value.sdk,value.tarball,value.metadata,{registry:'https://registry.example.test',distTag:'alpha',sourceArchive:value.sourceArchive}),/integrity does not match/)
  const wrongTag=fixture()
  assert.throws(()=>createSDKPublicationAttestation(wrongTag.sdk,wrongTag.tarball,wrongTag.metadata,{registry:'https://registry.example.test',distTag:'latest',sourceArchive:wrongTag.sourceArchive}),/dist-tag/)
  const wrongManifest=fixture()
  writeFileSync(join(wrongManifest.sdk,'manifest.json'),'{}\n')
  assert.throws(()=>createSDKPublicationAttestation(wrongManifest.sdk,wrongManifest.tarball,wrongManifest.metadata,{registry:'https://registry.example.test',distTag:'alpha',sourceArchive:wrongManifest.sourceArchive}),/manifest hash mismatch/)
})

test('rejects absent source provenance and non-HTTPS registries',()=>{
  const value=fixture(),record=JSON.parse(readFileSync(join(value.sdk,'release-record.json'),'utf8'))
  record.source.revision=null;writeFileSync(join(value.sdk,'release-record.json'),JSON.stringify(record))
  assert.throws(()=>createSDKPublicationAttestation(value.sdk,value.tarball,value.metadata,{registry:'https://registry.example.test',distTag:'alpha',sourceArchive:value.sourceArchive}),/SHA-256 source revision/)
  const changed=fixture();writeFileSync(changed.sourceArchive,'changed source')
  assert.throws(()=>createSDKPublicationAttestation(changed.sdk,changed.tarball,changed.metadata,{registry:'https://registry.example.test',distTag:'alpha',sourceArchive:changed.sourceArchive}),/revision mismatch/)
  const insecure=fixture()
  assert.throws(()=>createSDKPublicationAttestation(insecure.sdk,insecure.tarball,insecure.metadata,{registry:'http://registry.example.test',distTag:'alpha',sourceArchive:insecure.sourceArchive}),/must use HTTPS/)
})
