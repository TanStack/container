import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,basename} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {createSplitSDKPublicationAttestation as verify} from '../scripts/sdk-split-publication-attestation.mjs'
import {createSourceSnapshot} from '../scripts/source-snapshot.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=(path,value)=>writeFileSync(path,JSON.stringify(value))
function fixture(changePackage=()=>{},{packageLicense='MIT License\nfixture project license\n',sourceLicense='MIT License\nfixture project license\n'}={}){
  const root=mkdtempSync(join(tmpdir(),'split-publication-'))
  const options={registry:'https://registry.npmjs.org/',distTag:'alpha',sourceArchive:join(root,'source.tar'),acceptanceRecord:join(root,'acceptance.json'),deploymentDirectory:join(root,'deployment')}
  const sourceRoot=join(root,'source');mkdirSync(sourceRoot)
  if(sourceLicense!==null)writeFileSync(join(sourceRoot,'LICENSE'),sourceLicense)
  writeFileSync(join(sourceRoot,'index.js'),'export {}')
  createSourceSnapshot(sourceRoot,options.sourceArchive)
  writeFileSync(options.acceptanceRecord,'reviewed acceptance')
  options.expectedAcceptanceSHA256=hash(readFileSync(options.acceptanceRecord))
  const source=readFileSync(options.sourceArchive)
  const release=options.releaseRecord={format:1,status:'approved-split-candidate',source:{kind:'source-archive',revision:'sha256:'+hash(source),archive:{file:basename(options.sourceArchive),bytes:source.length,sha256:hash(source)}},packages:{},acceptanceSHA256:options.expectedAcceptanceSHA256,deploymentManifestSHA256:''}
  for(const role of ['sdk','runtime']){
    const base=join(root,role);mkdirSync(base)
    const directory=join(base,'package');mkdirSync(directory)
    const name=role==='sdk'?'@tanstack/browser-sandbox-experimental':'@tanstack/browser-sandbox-runtime-experimental'
    const pkg={name,version:'0.1.0-alpha.1',private:false,license:'MIT',publishConfig:{access:'public'},dependencies:role==='sdk'?{'@tanstack/browser-sandbox-runtime-experimental':'0.1.0-alpha.1'}:{}}
    changePackage(pkg,role)
    json(join(directory,'package.json'),pkg)
    const bytes=readFileSync(join(directory,'package.json'))
    const files=[{path:'package.json',bytes:bytes.length,sha256:hash(bytes)}]
    const license=typeof packageLicense==='function'?packageLicense(role):packageLicense
    if(license!==null){writeFileSync(join(directory,'LICENSE'),license);files.push({path:'LICENSE',bytes:Buffer.byteLength(license),sha256:hash(license)})}
    json(join(directory,'package-assets.json'),{format:1,files})
    const tarball=join(base,'package.tgz')
    assert.equal(spawnSync('tar',['-czf',tarball,'-C',base,'package']).status,0)
    const tarbytes=readFileSync(tarball),manifestSHA256=hash(readFileSync(join(directory,'package-assets.json')))
    options[role]={directory,tarball,registryMetadata:{name,'dist-tags':{alpha:pkg.version},versions:{[pkg.version]:{...pkg,dist:{tarball:`https://registry.npmjs.org/${role}.tgz`,integrity:'sha512-'+createHash('sha512').update(tarbytes).digest('base64')}}}}}
    release.packages[role]={name,version:pkg.version,private:false,license:'MIT',publishAccess:'public',manifestSHA256,tarballSHA256:hash(tarbytes)}
  }
  mkdirSync(options.deploymentDirectory)
  writeFileSync(join(options.deploymentDirectory,'worker.js'),'worker')
  json(join(options.deploymentDirectory,'deployment-manifest.json'),{format:1,packageManifestSHA256:release.packages.runtime.manifestSHA256,files:[{path:'worker.js',bytes:6,sha256:hash('worker')}]})
  release.deploymentManifestSHA256=hash(readFileSync(join(options.deploymentDirectory,'deployment-manifest.json')))
  return options
}
test('attests both exact published tarballs and reviewed deployment',()=>{
  const result=verify(fixture());assert.equal(result.status,'published');assert.equal(Object.keys(result.packages).length,2)
})
test('requires both packaged licenses to match the bound source archive',()=>{
  for(const role of ['sdk','runtime']){
    assert.throws(()=>verify(fixture(undefined,{packageLicense:current=>current===role?null:'MIT License\nfixture project license\n'})),/include its root LICENSE/)
    assert.throws(()=>verify(fixture(undefined,{packageLicense:current=>current===role?'different license':'MIT License\nfixture project license\n'})),/LICENSE differs from the source archive/)
  }
  assert.throws(()=>verify(fixture(undefined,{sourceLicense:null})),/one root LICENSE/)
  assert.throws(()=>verify(fixture(undefined,{sourceLicense:''})),/must not be empty/)
})
test('requires reviewed acceptance, source and deployment bindings',()=>{
  for(const change of [o=>delete o.expectedAcceptanceSHA256,o=>o.releaseRecord.acceptanceSHA256='0'.repeat(64),o=>writeFileSync(o.sourceArchive,'changed'),o=>writeFileSync(join(o.deploymentDirectory,'worker.js'),'broken')]){
    const options=fixture();change(options);assert.throws(()=>verify(options))
  }
})
test('rejects registry identity, integrity, tag and dependency changes on either package',()=>{
  for(const role of ['sdk','runtime'])for(const change of [m=>m.name='wrong',m=>m['dist-tags'].alpha='0.2.0-alpha.1',m=>m.versions['0.1.0-alpha.1'].dist.integrity='sha512-wrong',m=>m.versions['0.1.0-alpha.1'].dependencies={extra:'1.0.0'},m=>m.versions['0.1.0-alpha.1'].dist.tarball='http://example.com/file']){
    const options=fixture();change(options[role].registryMetadata);assert.throws(()=>verify(options))
  }
})
test('rejects changed, additional and misbound package files',()=>{
  for(const change of [o=>writeFileSync(join(o.sdk.directory,'package.json'),'{}'),o=>writeFileSync(join(o.runtime.directory,'extra'),'extra'),o=>o.releaseRecord.packages.runtime.manifestSHA256='0'.repeat(64),o=>o.releaseRecord.status='candidate']){
    const options=fixture();change(options);assert.throws(()=>verify(options))
  }
})
test('rejects private, nonalpha, nonMIT and loosely pinned packages before publication',()=>{
  for(const change of [p=>p.private=true,p=>p.version='0.1.0',p=>p.license='Apache-2.0',p=>p.publishConfig.access='restricted',(p,role)=>{if(role==='sdk')p.dependencies['@tanstack/browser-sandbox-runtime-experimental']='^0.1.0-alpha.1'}]){
    assert.throws(()=>verify(fixture(change)))
  }
})
