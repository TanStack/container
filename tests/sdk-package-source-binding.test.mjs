import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSourceSnapshot} from '../scripts/source-snapshot.mjs'
import {verifySDKPackageSources,resolveSDKPackageFormat} from '../scripts/build-sdk-packages.mjs'

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sdk-source-binding-')),projectRoot=join(root,'source'),staging=join(root,'staging'),sourceArchive=join(root,'source.tar.gz')
  mkdirSync(projectRoot);mkdirSync(staging);mkdirSync(join(projectRoot,'src/sdk'),{recursive:true})
  const helper=join(projectRoot,'src/sdk/package-assets.mjs')
  writeFileSync(helper,'export const prepareRuntimeAssets = async () => {}\n')
  writeFileSync(join(projectRoot,'LICENSE'),'MIT License\nfixture license\n')
  writeFileSync(join(staging,'LICENSE'),'MIT License\nfixture license\n')
  const snapshot=createSourceSnapshot(projectRoot,sourceArchive)
  const source={kind:'source-archive',revision:snapshot.revision,archive:snapshot.archive}
  const write=(name,value)=>writeFileSync(join(staging,name),JSON.stringify(value))
  write('package.json',{private:true,version:'0.1.0-alpha.0',license:'MIT',repository:{type:'git',url:'https://github.com/tanstack/container.git'}})
  write('release-record.json',{format:1,source})
  return {root,staging,helper,projectRoot,sourceArchive,source,write}
}

test('split sources match the same archive and source tree used by staging',()=>{
  const f=fixture(),result=verifySDKPackageSources(f.staging,f)
  assert.equal(result.status,'verified');assert.deepEqual(result.source,f.source)
  assert.match(result.tarSHA256,/^[a-f0-9]{64}$/)
})

test('changed current source helper fails before split packaging',()=>{
  const f=fixture()
  writeFileSync(f.helper,'export const prepareRuntimeAssets = () => "changed"\n')
  assert.throws(()=>verifySDKPackageSources(f.staging,f),/does not match the current source tree/)
})

test('a different archive cannot replace staging source provenance',()=>{
  const f=fixture()
  writeFileSync(f.helper,'changed source')
  const other=join(f.root,'other.tar.gz');createSourceSnapshot(f.projectRoot,other)
  assert.throws(()=>verifySDKPackageSources(f.staging,{...f,sourceArchive:other}),/differs from staging source revision/)
  assert.throws(()=>verifySDKPackageSources(f.staging,{projectRoot:f.projectRoot}),/SDK_SOURCE_ARCHIVE is required/)
})

test('private development remains explicitly unverified and cannot be retroactively source-bound',()=>{
  const f=fixture()
  f.write('package.json',{private:true,version:'0.0.0'})
  f.write('release-record.json',{format:1,source:{kind:'unavailable',revision:null,archive:null}})
  assert.equal(verifySDKPackageSources(f.staging,{projectRoot:f.projectRoot}).status,'unverified')
  assert.throws(()=>verifySDKPackageSources(f.staging,f),/Cannot add source provenance during splitting/)
  f.write('package.json',{private:true,version:'0.1.0-alpha.0'})
  assert.throws(()=>verifySDKPackageSources(f.staging,{projectRoot:f.projectRoot}),/Release staging requires a bound source archive/)
})

test('default split format stays private, explicit format uses verified alpha metadata',()=>{
  const f=fixture(),sourceBinding=verifySDKPackageSources(f.staging,f)
  assert.deepEqual(resolveSDKPackageFormat(f.staging),{private:true})
  assert.deepEqual(resolveSDKPackageFormat(f.staging,{publicationCandidate:true,sourceBinding,projectRoot:f.projectRoot}),{private:false,publishConfig:{access:'public'}})
  assert.throws(()=>resolveSDKPackageFormat(f.staging,{publicationCandidate:'true'}),/explicit boolean/)
})

test('publication format rejects unverified source, missing metadata and mismatched license',()=>{
  const f=fixture(),sourceBinding=verifySDKPackageSources(f.staging,f)
  assert.throws(()=>resolveSDKPackageFormat(f.staging,{publicationCandidate:true,sourceBinding:{status:'unverified'}}),/verified source binding/)
  const valid={private:true,version:'0.1.0-alpha.0',license:'MIT',repository:{type:'git',url:'https://github.com/tanstack/container.git'}}
  const cases=[
    [{...valid,version:undefined},/alpha version/],
    [{...valid,version:'0.0.0'},/alpha version/],
    [{...valid,license:undefined},/MIT metadata/],
    [{...valid,license:'Apache-2.0'},/MIT metadata/],
    [{...valid,repository:undefined},/git repository/],
    [{...valid,repository:{type:'git',url:'http://example.com/repo'}},/HTTPS/],
    [{...valid,repository:{type:'git',url:'https://user:secret@example.com/repo'}},/without credentials/],
  ]
  for(const [pkg,pattern]of cases){
    f.write('package.json',pkg)
    assert.throws(()=>resolveSDKPackageFormat(f.staging,{publicationCandidate:true,sourceBinding,projectRoot:f.projectRoot}),pattern)
  }
  f.write('package.json',valid)
  writeFileSync(join(f.staging,'LICENSE'),'different license')
  assert.throws(()=>resolveSDKPackageFormat(f.staging,{publicationCandidate:true,sourceBinding,projectRoot:f.projectRoot}),/differs from verified source/)
})
