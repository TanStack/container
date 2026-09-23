import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstatSync,readFileSync,realpathSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isAlphaSDKVersion,isSupportedSDKLicense} from './sdk-license-policy.mjs'
import {resolveSDKPackageMetadata} from './sdk-package-metadata.mjs'

const packageName='@tanstack/browser-sandbox-experimental'

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')

function releasePath(value,label){
  assert.ok(typeof value==='string'&&/^[A-Za-z0-9_@./-]+$/.test(value)&&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'),`Invalid ${label} path`)
  return value
}

function inspectReleaseDistributionReview(sdk,manifest){
  const claim=manifest.licenseCoverage
  assert.ok(claim?.path==='licenses/SHIPPED-INPUTS.json'&&/^[a-f0-9]{64}$/.test(claim.sha256),'Release package is missing hash-bound shipped-input evidence')
  const coveragePath=resolve(sdk,releasePath(claim.path,'shipped-input evidence'))
  const coverageBytes=readFileSync(coveragePath)
  assert.equal(sha256(coverageBytes),claim.sha256,'Release shipped-input evidence differs from the manifest')
  const coverage=JSON.parse(coverageBytes),review=coverage.distributionReview
  assert.ok(review&&review.complete===true,'Release third-party distribution review is missing or incomplete')
  assert.deepEqual(review.missingPackageNoticeText,[],'Release third-party distribution review has missing package notice text')
  assert.deepEqual(review.unverified,[],'Release third-party distribution review has unverified findings')
  assert.ok(review.rustEvidence?.exactLinkedContents===true&&Array.isArray(review.rustEvidence.unresolvedMissingNoticeRecords)&&review.rustEvidence.unresolvedMissingNoticeRecords.length===0,'Release Rust distribution review is incomplete')
  assert.ok(review.rustSysrootEvidence?.exactLinkedContents===true,'Release Rust sysroot distribution review is incomplete')

  const files=new Map((manifest.files??[]).map(file=>[file.path,file]))
  const verifyFile=(path,label,expectedHash)=>{
    releasePath(path,label)
    const entry=files.get(path)
    assert.ok(entry&&/^[a-f0-9]{64}$/.test(entry.sha256),`Release ${label} is not bound by the manifest: ${path}`)
    const absolute=resolve(sdk,path),stat=lstatSync(absolute)
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),`Release ${label} must be a regular file: ${path}`)
    const bytes=readFileSync(absolute),actual=sha256(bytes)
    assert.equal(actual,entry.sha256,`Release ${label} differs from the manifest: ${path}`)
    if(expectedHash!==undefined)assert.equal(actual,expectedHash,`Release ${label} differs from the distribution review: ${path}`)
  }
  const notices=[coverage.generatedBundles?.notice,...(coverage.native??[]).flatMap(item=>[...(item.notices??[]),...(item.notice?[item.notice]:[])])]
  assert.ok(notices.length>0&&notices.every(Boolean),'Release shipped-input evidence has no required notices')
  for(const path of new Set(notices))verifyFile(path,'third-party notice')
  for(const [name,evidence] of Object.entries({package:review.packageEvidence,rust:review.rustEvidence,rustSysroot:review.rustSysrootEvidence})){
    assert.ok(evidence&&/^[a-f0-9]{64}$/.test(evidence.sha256),`Release ${name} distribution evidence is missing its hash`)
    verifyFile(evidence.path,`${name} distribution evidence`,evidence.sha256)
  }
  return coverage
}

export function inspectSDKReleasePackage(directory,{environment=process.env,projectRoot=process.cwd()}={}){
  assert.equal(environment.SDK_RELEASE,'1','Release publish validation requires SDK_RELEASE=1')
  const expectedVersion=environment.SDK_RELEASE_VERSION?.trim()
  const expectedLicense=environment.SDK_RELEASE_LICENSE?.trim()
  assert.ok(isAlphaSDKVersion(expectedVersion),'SDK_RELEASE_VERSION must be an explicit alpha semantic version')
  assert.ok(isSupportedSDKLicense(expectedLicense),'SDK_RELEASE_LICENSE must be a supported SPDX identifier')

  const sdk=realpathSync(resolve(directory))
  const packageJSON=JSON.parse(readFileSync(resolve(sdk,'package.json'),'utf8'))
  const manifest=JSON.parse(readFileSync(resolve(sdk,'manifest.json'),'utf8'))
  assert.equal(packageJSON.name,packageName,'Unexpected SDK package name')
  assert.notEqual(packageJSON.private,true,'Private SDK candidates cannot enter publish validation')
  assert.equal(packageJSON.version,expectedVersion,'Built package version differs from SDK_RELEASE_VERSION')
  assert.equal(packageJSON.license,expectedLicense,'Built package license differs from SDK_RELEASE_LICENSE')
  assert.deepEqual(packageJSON.publishConfig,{access:'public'},'Release package must publish with public access')
  const expectedMetadata=resolveSDKPackageMetadata({environment,projectRoot}).packageFields
  for(const field of ['description','keywords','repository','homepage','bugs']){
    assert.deepEqual(packageJSON[field],expectedMetadata[field],`Built package ${field} differs from release metadata`)
  }

  const projectLicense=manifest.projectLicense
  assert.ok(projectLicense&&projectLicense.path==='LICENSE','Release manifest must declare the packaged LICENSE')
  assert.equal(projectLicense.spdx,expectedLicense,'Release manifest license differs from SDK_RELEASE_LICENSE')
  const licensePath=resolve(sdk,projectLicense.path),stat=lstatSync(licensePath)
  assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Packaged LICENSE must be a regular file')
  const licenseBytes=readFileSync(licensePath),sha256=createHash('sha256').update(licenseBytes).digest('hex')
  assert.equal(projectLicense.sha256,sha256,'Packaged LICENSE differs from the release manifest')
  const sourceLicensePath=resolve(projectRoot,'LICENSE'),sourceStat=lstatSync(sourceLicensePath)
  assert.ok(sourceStat.isFile()&&!sourceStat.isSymbolicLink(),'Repository LICENSE must be a regular file')
  assert.deepEqual(licenseBytes,readFileSync(sourceLicensePath),'Packaged LICENSE differs from the repository LICENSE')
  inspectReleaseDistributionReview(sdk,manifest)
  return {sdk,packageJSON,manifest}
}

export function validateSDKReleasePublish(directory,options={}){
  const {environment=process.env,projectRoot=process.cwd(),spawn=spawnSync}=options
  const release=inspectSDKReleasePackage(directory,{environment,projectRoot})
  const result=spawn('npm',['publish',release.sdk,'--tag','alpha','--dry-run','--json','--ignore-scripts'],{
    encoding:'utf8',
    env:{...environment,npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'},
  })
  if(result.status!==0)throw Error(`npm publish --dry-run failed\n${result.stdout??''}${result.stderr??''}`)
  return {release,output:result.stdout}
}

const invoked=process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)
if(invoked){
  assert.equal(process.argv.length,3,'Usage: node scripts/validate-sdk-release-publish.mjs SDK_DIRECTORY')
  const result=validateSDKReleasePublish(process.argv[2])
  process.stdout.write(result.output)
}
