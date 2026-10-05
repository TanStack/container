import assert from 'node:assert/strict'
import test from 'node:test'
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {nativeReleaseExamples,nativeExampleHash,readPinnedNativeExamples} from '../scripts/native-example-sources.mjs'
import {nativeReleaseAcceptancePlan,nativeReleaseRunnerIdentity} from '../scripts/native-release-acceptance.mjs'

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'native-example-source-test-'))
  const directory=join(root,'tests/fixtures/native-owner-sources')
  mkdirSync(join(root,'tests/fixtures'),{recursive:true})
  cpSync('tests/fixtures/native-owner-sources',directory,{recursive:true,errorOnExist:true,force:false})
  for(const example of nativeReleaseExamples){
    const output=join(root,'fixtures',example.fixture)
    mkdirSync(output,{recursive:true})
    cpSync(join('fixtures',example.fixture,'package-lock.json'),join(output,'package-lock.json'))
  }
  return {root,directory}
}

test('portable sources retain all original manifests, lockfiles and binary assets',()=>{
  const loaded=readPinnedNativeExamples()
  assert.equal(loaded.examples.size,5)
  assert.equal(loaded.manifest.revision,'b839f47027956f71ed2db51f436701801addb1d6')
  for(const example of nativeReleaseExamples){
    const {files}=loaded.examples.get(example.kind+'/'+example.path)
    assert.deepEqual(files['/project/package.json'],new Uint8Array(readFileSync(join('fixtures',example.fixture,'package.json'))))
    assert.equal(files['/project/package-lock.json'],readFileSync(join('fixtures',example.fixture,'package-lock.json'),'utf8'))
  }
  const basic=loaded.examples.get('react/start-basic').files
  assert.deepEqual([...basic['/project/public/favicon-32x32.png'].slice(0,8)],[137,80,78,71,13,10,26,10])
  assert.ok(basic['/project/src/routes/customScript[.]js.ts'].length>0)
})

test('changed snapshots, locks and license text fail the source checks',()=>{
  for(const target of ['snapshot','lock','license']){
    const {root,directory}=fixture()
    const path=target==='snapshot'?join(directory,'react-start-counter.json'):
      target==='license'?join(directory,'LICENSE'):join(root,'fixtures/native-real-counter/package-lock.json')
    writeFileSync(path,readFileSync(path)+'\n')
    assert.throws(()=>readPinnedNativeExamples(root),/snapshot changed|lockfile changed|license changed/)
  }
})

test('missing examples and invalid source paths do not become release inputs',()=>{
  const {root,directory}=fixture(),manifestPath=join(directory,'manifest.json')
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'))
  const snapshotPath=join(directory,manifest.examples[0].snapshot)
  const snapshot=JSON.parse(readFileSync(snapshotPath,'utf8'))
  snapshot.files[0].path='../outside'
  const bytes=Buffer.from(JSON.stringify(snapshot))
  writeFileSync(snapshotPath,bytes)
  manifest.examples[0].sha256=nativeExampleHash(bytes)
  writeFileSync(manifestPath,JSON.stringify(manifest))
  assert.throws(()=>readPinnedNativeExamples(root),/Unsafe native example source path/)
  manifest.examples.pop()
  writeFileSync(manifestPath,JSON.stringify(manifest))
  assert.throws(()=>readPinnedNativeExamples(root),/all five pinned examples/)
})

test('release browser plan uses installed inputs, original deadlines and no inherited filters',()=>{
  const plan=nativeReleaseAcceptancePlan({root:'/release',sdk:'/consumer/sdk',deployment:'/consumer/hosted',env:{
    PATH:'/bin',NATIVE_OWNER_EXAMPLE:'start-counter',NATIVE_OWNER_IDENTITY_ONLY:'1',NATIVE_OWNER_MODULE_TRACE:'1',
    NATIVE_OWNER_CONTINUE_ON_FAILURE:'1',NATIVE_OWNER_LOCKLESS:'1',TANSTACK_ROUTER_SOURCE:'/neighbor/router',
  }})
  assert.deepEqual(plan.map(entry=>entry.browser),['chromium','firefox','webkit'])
  for(const entry of plan){
    assert.equal(entry.command,process.execPath)
    assert.deepEqual(entry.args,['--test','--test-force-exit','--test-timeout=180000','/release/tests/native-owner-sdk.test.mjs'])
    assert.deepEqual(entry.options.env,{PATH:'/bin',NATIVE_SDK_BUNDLE_DIR:'/consumer/sdk',
      NATIVE_DEPLOYMENT_DIR:'/consumer/hosted',NATIVE_OWNER_RUNTIME_CATALOG:'1',
      NATIVE_OWNER_PINNED_EXAMPLES:'1',NATIVE_TEST_BROWSER:entry.browser})
  }
})

test('acceptance runner identity binds the timing helper and notices changes or missing inputs',()=>{
  const expected=nativeReleaseRunnerIdentity(process.cwd())
  const helper='scripts/native-owner-timings.mjs'
  assert.equal(expected[helper],nativeExampleHash(readFileSync(helper)))
  const root=mkdtempSync(join(tmpdir(),'native-runner-identity-test-'))
  for(const path of Object.keys(expected)){
    mkdirSync(dirname(join(root,path)),{recursive:true})
    cpSync(path,join(root,path),{errorOnExist:true,force:false})
  }
  assert.deepEqual(nativeReleaseRunnerIdentity(root),expected)
  writeFileSync(join(root,helper),readFileSync(join(root,helper))+'\n// changed test input\n')
  const changed=nativeReleaseRunnerIdentity(root)
  assert.notEqual(changed[helper],expected[helper])
  for(const path of Object.keys(expected).filter(path=>path!==helper))assert.equal(changed[path],expected[path])
  // Remove only the test's own copied helper, never a source or installed file.
  unlinkSync(join(root,helper))
  assert.throws(()=>nativeReleaseRunnerIdentity(root),{code:'ENOENT'})
})
