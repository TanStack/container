import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {inspectSDKReleasePackage,validateSDKReleasePublish} from '../scripts/validate-sdk-release-publish.mjs'
import {SDK_PACKAGE_DESCRIPTION,SDK_PACKAGE_KEYWORDS} from '../scripts/sdk-package-metadata.mjs'

const environment={SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.4',SDK_RELEASE_LICENSE:'MIT',SDK_RELEASE_REPOSITORY_URL:'https://example.com/default/project.git'}

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

function fixture({privatePackage=false,distributionReview='complete',missingNotice=false}={}){
  const root=mkdtempSync(join(tmpdir(),'sdk-release-publish-'))
  const license='approved license text\n'
  writeFileSync(join(root,'LICENSE'),license)
  writeFileSync(join(root,'package.json'),JSON.stringify({
    name:'@tanstack/browser-sandbox-experimental',version:environment.SDK_RELEASE_VERSION,
    ...(privatePackage?{private:true}:{}),license:environment.SDK_RELEASE_LICENSE,
    description:SDK_PACKAGE_DESCRIPTION,keywords:SDK_PACKAGE_KEYWORDS,publishConfig:{access:'public'},
    repository:{type:'git',url:environment.SDK_RELEASE_REPOSITORY_URL},
  }))
  const files=[]
  function shipped(path,body){
    const absolute=join(root,path)
    mkdirSync(join(absolute,'..'),{recursive:true})
    writeFileSync(absolute,body)
    files.push({path,bytes:Buffer.byteLength(body),sha256:hash(body)})
    return {path,sha256:hash(body)}
  }
  const packageEvidence=shipped('licenses/PACKAGE-EVIDENCE.json','package evidence\n')
  const rustEvidence=shipped('licenses/RUST-EVIDENCE.json','rust evidence\n')
  const rustSysrootEvidence=shipped('licenses/RUST-SYSROOT-EVIDENCE.json','rust sysroot evidence\n')
  shipped('licenses/THIRD-PARTY-NOTICES.txt','dependency notice\n')
  if(!missingNotice)shipped('licenses/PARSER-LICENSE','parser notice\n')
  const coverage={
    format:1,
    generatedBundles:{notice:'licenses/THIRD-PARTY-NOTICES.txt'},
    native:[{source:'fixture parser',notices:['licenses/PARSER-LICENSE']}],
    ...(distributionReview==='missing'?{}:{distributionReview:{
      complete:distributionReview==='complete',packageEvidence,
      rustEvidence:{...rustEvidence,exactLinkedContents:distributionReview==='complete',unresolvedMissingNoticeRecords:distributionReview==='complete'?[]:['fixture-crate@1.0.0']},
      rustSysrootEvidence:{...rustSysrootEvidence,exactLinkedContents:distributionReview==='complete'},
      missingPackageNoticeText:distributionReview==='complete'?[]:['fixture-package@1.0.0'],
      unverified:distributionReview==='complete'?[]:['fixture review remains open'],
    }}),
  }
  const coverageText=JSON.stringify(coverage),coverageHash=hash(coverageText)
  shipped('licenses/SHIPPED-INPUTS.json',coverageText)
  writeFileSync(join(root,'manifest.json'),JSON.stringify({projectLicense:{
    path:'LICENSE',spdx:environment.SDK_RELEASE_LICENSE,
    sha256:hash(license),
  },licenseCoverage:{path:'licenses/SHIPPED-INPUTS.json',sha256:coverageHash,packageCount:1},files}))
  return root
}

test('release validation runs only npm publish dry-run for an exact release package',()=>{
  const root=fixture(),calls=[]
  const result=validateSDKReleasePublish(root,{environment,projectRoot:root,spawn(...args){calls.push(args);return {status:0,stdout:'[]\n',stderr:''}}})
  const sdk=realpathSync(root)
  assert.equal(result.release.sdk,sdk)
  assert.deepEqual(calls.map(([command,args])=>[command,args]),[
    ['npm',['publish',sdk,'--tag','alpha','--dry-run','--json','--ignore-scripts']],
  ])
})

test('release validation requires a complete hash-bound third-party distribution review',()=>{
  const complete=fixture()
  assert.doesNotThrow(()=>inspectSDKReleasePackage(complete,{environment,projectRoot:complete}))
  for(const distributionReview of ['missing','incomplete']){
    const root=fixture({distributionReview})
    assert.throws(()=>inspectSDKReleasePackage(root,{environment,projectRoot:root}),/distribution review is missing or incomplete/)
  }
})

test('release validation rejects a required notice missing from the reviewed package',()=>{
  const root=fixture({missingNotice:true})
  assert.throws(()=>inspectSDKReleasePackage(root,{environment,projectRoot:root}),/third-party notice is not bound by the manifest/)
})

test('release validation binds the required repository and optional public URLs to explicit values',()=>{
  const urls={
    SDK_RELEASE_REPOSITORY_URL:'https://example.com/owner/project.git',
    SDK_RELEASE_HOMEPAGE_URL:'https://example.com/project',
    SDK_RELEASE_BUGS_URL:'https://example.com/owner/project/issues',
  }
  const root=fixture()
  const packageJSON=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
  Object.assign(packageJSON,{
    repository:{type:'git',url:urls.SDK_RELEASE_REPOSITORY_URL},
    homepage:urls.SDK_RELEASE_HOMEPAGE_URL,
    bugs:{url:urls.SDK_RELEASE_BUGS_URL},
  })
  writeFileSync(join(root,'package.json'),JSON.stringify(packageJSON))
  assert.doesNotThrow(()=>inspectSDKReleasePackage(root,{environment:{...environment,...urls},projectRoot:root}))
  assert.throws(()=>inspectSDKReleasePackage(root,{environment,projectRoot:root}),/repository differs/)
})

test('release validation rejects a package or build request without a source repository',()=>{
  const root=fixture()
  assert.throws(()=>inspectSDKReleasePackage(root,{environment:{...environment,SDK_RELEASE_REPOSITORY_URL:undefined},projectRoot:root}),/SDK_RELEASE_REPOSITORY_URL is required/)
  const packageJSON=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
  delete packageJSON.repository
  writeFileSync(join(root,'package.json'),JSON.stringify(packageJSON))
  assert.throws(()=>inspectSDKReleasePackage(root,{environment,projectRoot:root}),/repository differs/)
})

test('ordinary and private SDK builds cannot enter publication validation',()=>{
  const root=fixture()
  assert.throws(()=>inspectSDKReleasePackage(root,{environment:{},projectRoot:root}),/requires SDK_RELEASE=1/)
  const privateRoot=fixture({privatePackage:true})
  assert.throws(()=>inspectSDKReleasePackage(privateRoot,{environment,projectRoot:privateRoot}),/Private SDK candidates/)
})

test('release validation rejects metadata or license bytes that differ from the build request',()=>{
  const root=fixture()
  assert.throws(()=>inspectSDKReleasePackage(root,{environment:{...environment,SDK_RELEASE_VERSION:'0.1.0-alpha.5'},projectRoot:root}),/version differs/)
  writeFileSync(join(root,'LICENSE'),'changed after build\n')
  assert.throws(()=>inspectSDKReleasePackage(root,{environment,projectRoot:root}),/LICENSE differs/)
})

test('release validation rejects a packaged license that differs from the repository license',()=>{
  const root=fixture(),projectRoot=mkdtempSync(join(tmpdir(),'sdk-release-source-'))
  writeFileSync(join(projectRoot,'LICENSE'),'different repository license\n')
  assert.throws(()=>inspectSDKReleasePackage(root,{environment,projectRoot}),/repository LICENSE/)
})
