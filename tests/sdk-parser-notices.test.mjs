import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {writeSDKNotices} from '../scripts/sdk-notices.mjs'
import {buildRolldownParser} from '../scripts/build-rolldown-parser.mjs'
import {parserNoticeInventory} from '../scripts/parser-notice-inventory.mjs'
test('parser input coverage records available notices and unresolved distribution evidence',async()=>{
  const root=resolve('.'),dependencies=resolve('tests/fixtures/rolldown-native-probe'),out=mkdtempSync(join(tmpdir(),'sdk-parser-notices-'))
  mkdirSync(join(out,'runtime'))
  const artifact=await buildRolldownParser(dependencies,join(out,'runtime/rolldown-parser'))
  const inputIds=new Set(Object.keys(artifact.sources).map(path=>path.startsWith('npm/')?join(dependencies,'node_modules',path.slice(4)):join(root,path.slice(10))))
  writeSDKNotices(out,root,inputIds,{},dependencies)
  const coverage=JSON.parse(readFileSync(join(out,'licenses/SHIPPED-INPUTS.json'),'utf8'))
  assert.equal(coverage.distributionReview.complete,false)
  assert.ok(!coverage.distributionReview.missingPackageNoticeText.includes('@rolldown/binding-wasm32-wasi@1.2.9'))
  assert.ok(!coverage.distributionReview.missingPackageNoticeText.includes('@napi-rs/wasm-runtime@1.2.4'))
  assert.match(readFileSync(join(out,'licenses/THIRD-PARTY-NOTICES.txt'),'utf8'),/Copyright \(c\) 2020-present LongYinan/)
  assert.equal(coverage.distributionReview.rustEvidence.exactLinkedContents,false)
  assert.equal(coverage.distributionReview.rustEvidence.coveredMissingNoticeRecords,43)
  assert.deepEqual(coverage.distributionReview.rustEvidence.unresolvedMissingNoticeRecords,['base-encode@0.3.1','escape-simd@0.1.0','json-escape-simd@3.1.2','typedmap@0.6.0'])
  assert.deepEqual(coverage.distributionReview.rustSysrootEvidence,{path:'licenses/RUST-WASI-SYSROOT-NOTICE-EVIDENCE.json',sha256:coverage.distributionReview.rustSysrootEvidence.sha256,exactLinkedContents:false,rustVersion:'1.98.1',target:'wasm32-wasip1-threads',wasiSDK:'33.0'})
  assert.ok(coverage.distributionReview.unverified.some(item=>item.includes('not proof of the exact Rust code linked')))
  const parserRuntime=coverage.native.find(item=>item.artifacts.includes('runtime/rolldown-parser/'))
  assert.equal(parserRuntime.evidence,'licenses/ROLLDOWN-RUST-NOTICE-EVIDENCE.json')
  assert.ok(parserRuntime.notices.includes('licenses/ROLLDOWN-RUST-NOTICE-INVENTORY.json'))
  assert.ok(parserRuntime.notices.includes('licenses/ROLLDOWN-RUST-UNRESOLVED-NOTICES.json'))
  assert.equal(parserRuntime.sysrootEvidence,'licenses/RUST-WASI-SYSROOT-NOTICE-EVIDENCE.json')
  assert.ok(parserRuntime.notices.includes('licenses/rust-1.98.1-COPYRIGHT-library.html'))
  assert.ok(parserRuntime.notices.includes('licenses/wasi-libc-161b3195-LICENSE'))
  assert.ok(parserRuntime.notices.includes('licenses/llvm-4434dabb-LICENSE.txt'))
  for(const notice of parserRuntime.notices)assert.ok(readFileSync(join(out,notice)).length>0)
  const sysrootEvidence=JSON.parse(readFileSync(join(out,parserRuntime.sysrootEvidence),'utf8'))
  assert.equal(sysrootEvidence.rolldown.bindingWasmSHA256,artifact.inputs['@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm'])
  assert.equal(sysrootEvidence.complete,false)
  assert.equal(sysrootEvidence.exactLinkedContents,false)
  const compilerRuntime=coverage.native.find(item=>item.evidence==='licenses/EMSCRIPTEN-NOTICE-EVIDENCE.json')
  assert.equal(compilerRuntime.notices.length,3)
  const compilerEvidence=JSON.parse(readFileSync(join(out,compilerRuntime.evidence),'utf8'))
  assert.equal(compilerEvidence.version,'5.0.1')
  for(const notice of compilerEvidence.notices){
    assert.equal(createHash('sha256').update(readFileSync(join(out,notice.path))).digest('hex'),notice.sha256)
  }
  assert.equal(readFileSync(join(out,'licenses/ROLLDOWN-THIRD-PARTY-LICENSE'),'utf8'),readFileSync(join(dependencies,'node_modules/rolldown/THIRD-PARTY-LICENSE'),'utf8'))
  assert.ok(!JSON.stringify(coverage).includes(root))
  assert.ok(!JSON.stringify(artifact).includes(root))
  const bytes=readFileSync(join(out,coverage.distributionReview.packageEvidence.path))
  assert.equal(createHash('sha256').update(bytes).digest('hex'),coverage.distributionReview.packageEvidence.sha256)
  const inventory=JSON.parse(bytes)
  assert.equal(inventory.complete,false)
  assert.deepEqual(inventory.artifactAssets,artifact.assets)
  assert.equal(inventory.lockSHA256,artifact.lockSHA256)
  for(const name of ['@rolldown/binding-wasm32-wasi','@napi-rs/wasm-runtime']){
    const record=inventory.packages.find(pkg=>pkg.name===name)
    assert.equal(record.noticeStatus,'upstream-notice-present')
    assert.equal(record.declaredLicense,'MIT')
    assert.equal(record.lockedArchive.verifiedHere,false)
    assert.match(record.lockedArchive.integrity,/^sha512-/)
    assert.ok(Object.keys(record.inputs).length>0)
    assert.match(record.packageJSONSHA256,/^[a-f0-9]{64}$/)
  }
  const parent=inventory.packages.find(pkg=>pkg.name==='rolldown')
  assert.ok(parent.notices.some(notice=>notice.path==='THIRD-PARTY-LICENSE'))
  assert.ok(!bytes.toString().includes(root))
  assert.throws(()=>parserNoticeInventory(dependencies,{...artifact,lockSHA256:'bad'}),/lock does not match/)
  assert.throws(()=>parserNoticeInventory(dependencies,{...artifact,inputs:{...artifact.inputs,'@napi-rs/wasm-runtime/runtime.js':'bad'}}),/input hash mismatch/)
})

test('records exact project license attribution in shipped inputs',()=>{
  const root=mkdtempSync(join(tmpdir(),'sdk-project-notice-')),out=join(root,'out')
  mkdirSync(out)
  const licensePath=join(root,'LICENSE'),license='MIT project license\n'
  writeFileSync(licensePath,license)
  writeSDKNotices(out,resolve('.'),new Set(),{},undefined,{path:licensePath,spdx:'MIT'})
  const coverage=JSON.parse(readFileSync(join(out,'licenses/SHIPPED-INPUTS.json'),'utf8'))
  assert.deepEqual(coverage.projectLicense,{path:'LICENSE',spdx:'MIT',sha256:createHash('sha256').update(license).digest('hex')})
  assert.ok(coverage.localArtifacts.includes('LICENSE'))
})
