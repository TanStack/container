import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync,copyFileSync,constants} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readReleasePackages,releasePackages} from './build-release-packages.mjs'
import {installedPackageInventory,testSDKPackages} from './test-sdk-packages.mjs'
import {verifySourceSnapshot} from './source-snapshot.mjs'
import {runNativeReleaseAcceptance} from './native-release-acceptance.mjs'

export function verifyReleasePackageMetadata(root=process.cwd()){
  const manifests=readReleasePackages(root)
  for(const [key,path] of Object.entries(releasePackages)){
    const directory=join(root,path,'dist'),pkg=JSON.parse(readFileSync(join(directory,'package.json')))
    installedPackageInventory(directory)
    assert.equal(pkg.name,manifests[key].name)
    assert.equal(pkg.version,manifests[key].version)
    assert.equal(pkg.private,false)
    assert.equal(pkg.license,'MIT')
    assert.equal(pkg.publishConfig.access,'public')
    assert.equal(pkg.publishConfig.directory,undefined,'Generated package must not redirect publishing')
    assert.equal(pkg.repository.url,manifests[key].repository.url)
    if(key==='sdk')assert.equal(pkg.dependencies[manifests.runtime.name],manifests.runtime.version)
  }
  return manifests
}

export async function verifyReleasePackages(root=process.cwd()){
  root=resolve(root)
  const manifests=verifyReleasePackageMetadata(root)
  const record=JSON.parse(readFileSync(join(root,'dist/release-build.json')))
  assert.equal(record.version,manifests.sdk.version)
  const source=verifySourceSnapshot(root,record.sourceArchive)
  assert.equal(source.revision,record.source.revision)
  for(const [key,path] of Object.entries(releasePackages)){
    const split=join(record.splitRoot,key==='sdk'?'sdk':'runtime')
    assert.deepEqual(installedPackageInventory(split),installedPackageInventory(join(root,path,'dist')),'Split and publish bytes differ')
  }
  const adoption=await testSDKPackages(record.splitRoot)
  const nativeAcceptance=runNativeReleaseAcceptance({root,
    sdk:join(adoption.consumer,'node_modules/@tanstack/browser-sandbox-experimental'),
    deployment:adoption.output.directory})
  verifyReleasePackageMetadata(root)
  verifySourceSnapshot(root,record.sourceArchive)
  const archives=join(root,'dist/release-tarballs')
  mkdirSync(archives)
  const tarballs=[]
  for(const path of Object.values(releasePackages)){
    const result=JSON.parse(execFileSync('npm',['pack',join(root,path,'dist'),'--json','--ignore-scripts','--pack-destination',archives],{encoding:'utf8'}))
    assert.equal(result.length,1)
    const bytes=readFileSync(join(archives,result[0].filename))
    tarballs.push({file:result[0].filename,sha256:createHash('sha256').update(bytes).digest('hex')})
  }
  writeFileSync(join(root,'dist/release-verification.json'),JSON.stringify({version:record.version,source,adoption,nativeAcceptance,tarballs,actualSafari:false},null,2)+'\n',{flag:'wx'})
  copyFileSync(record.sourceArchive,join(root,'dist/release-source.tar.gz'),constants.COPYFILE_EXCL)
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await verifyReleasePackages()
