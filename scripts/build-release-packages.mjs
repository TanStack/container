import assert from 'node:assert/strict'
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createSourceSnapshot} from './source-snapshot.mjs'
import {buildSDKPackages} from './build-sdk-packages.mjs'
import {isAlphaSDKVersion} from './sdk-license-policy.mjs'
import {nativeRuntimeBuildPlan,inspectNativeRuntimeBuild} from './native-runtime-build-plan.mjs'

export const releasePackages={sdk:'packages/browser-sandbox',runtime:'packages/browser-sandbox-runtime'}
export const releaseProfile='native'
export function readReleasePackages(root=process.cwd()){
  const manifests=Object.fromEntries(Object.entries(releasePackages).map(([key,path])=>[key,JSON.parse(readFileSync(join(root,path,'package.json')))]))
  assert.equal(manifests.sdk.name,'@tanstack/browser-sandbox-experimental')
  assert.equal(manifests.runtime.name,'@tanstack/browser-sandbox-runtime-experimental')
  assert.equal(manifests.sdk.version,manifests.runtime.version,'SDK/runtime versions must stay together')
  assert.ok(isAlphaSDKVersion(manifests.sdk.version),'This release pipeline currently supports alpha versions only')
  assert.equal(manifests.sdk.dependencies[manifests.runtime.name],manifests.runtime.version)
  for(const pkg of Object.values(manifests)){
    assert.notEqual(pkg.private,true)
    assert.equal(pkg.license,'MIT')
    assert.equal(pkg.publishConfig.directory,'dist')
    assert.equal(pkg.publishConfig.access,'public')
    assert.equal(pkg.publishConfig.tag,'alpha')
    assert.equal(pkg.repository.url,'https://github.com/TanStack/container.git')
  }
  return manifests
}

export async function buildReleasePackages(root=process.cwd()){
  root=resolve(root)
  const manifests=readReleasePackages(root)
  for(const path of Object.values(releasePackages))assert.ok(!existsSync(join(root,path,'dist')),'Release output exists; use a fresh checkout')
  const recordPath=join(root,'dist/release-build.json')
  assert.ok(!existsSync(recordPath),'Release build record already exists')
  const nativePlan=nativeRuntimeBuildPlan(root)
  inspectNativeRuntimeBuild(nativePlan)
  const nativeSources=nativePlan.map(item=>item.output)
  const scratch=mkdtempSync(join(tmpdir(),'container-release-'))
  const sourceArchive=join(scratch,'source.tar.gz')
  const source=createSourceSnapshot(root,sourceArchive)
  const env={...process.env,SDK_RELEASE:'1',SDK_RELEASE_VERSION:manifests.sdk.version,
    SDK_RELEASE_LICENSE:'MIT',SDK_RELEASE_REPOSITORY_URL:'https://github.com/TanStack/container.git',
    SDK_SOURCE_ARCHIVE:sourceArchive,SDK_BUILD_PROFILE:releaseProfile,
    SDK_NATIVE_RUNTIME_ROOTS:JSON.stringify(nativeSources)}
  delete env.SDK_NATIVE_RUNTIME_ROOT
  delete env.SDK_ROLLDOWN_PARSER_ROOT
  const output=execFileSync(process.execPath,['scripts/build-sdk.mjs'],{cwd:root,env,encoding:'utf8',maxBuffer:64*1024*1024})
  process.stdout.write(output)
  const matches=[...output.matchAll(/^SDK_OUTPUT=(.+)$/gm)]
  assert.equal(matches.length,1,'Expected one SDK staging output')
  const split=await buildSDKPackages(matches[0][1],{sourceArchive,publicationCandidate:true})
  for(const [key,path] of Object.entries(releasePackages)){
    const sourcePath=key==='sdk'?split.core:split.runtime
    const built=JSON.parse(readFileSync(join(sourcePath,'package.json')))
    assert.equal(built.name,manifests[key].name)
    assert.equal(built.version,manifests[key].version)
    // Preserve generated package inventories exactly. publishConfig.directory
    // belongs to the tracked workspace manifest, not its generated package.
    cpSync(sourcePath,join(root,path,'dist'),{recursive:true,errorOnExist:true,force:false})
  }
  mkdirSync(join(root,'dist'),{recursive:true})
  const record={format:1,version:manifests.sdk.version,source,sourceArchive,splitRoot:split.output}
  writeFileSync(recordPath,JSON.stringify(record,null,2)+'\n',{flag:'wx'})
  return record
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildReleasePackages()
