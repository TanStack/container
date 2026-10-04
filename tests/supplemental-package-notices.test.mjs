import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {supplementalPackageNotice} from '../scripts/supplemental-package-notices.mjs'
const require=createRequire(import.meta.url)

// Exact published manifests, not rewritten identities or installed optional
// binaries. Supplemental hashes bind these bytes just as they bind npm inputs.
function packageFixture(name){
  const directory=mkdtempSync(join(tmpdir(),'package-notice-identity-'))
  writeFileSync(join(directory,'package.json'),readFileSync(new URL(`./fixtures/package-notice-identities/${name}.json.txt`,import.meta.url)))
  return directory
}

test('parser notice matches the registry provenance subject and pinned source',()=>{
  const directory=packageFixture('rolldown-binding-1.2.9')
  const manifest=JSON.parse(readFileSync(join(directory,'package.json')))
  const notice=supplementalPackageNotice(directory,manifest)
  const lock=JSON.parse(readFileSync('tests/fixtures/rolldown-native-probe/package-lock.json'))
  const integrity=lock.packages['node_modules/@rolldown/binding-wasm32-wasi'].integrity
  assert.equal('sha512-'+Buffer.from(notice.provenanceSubjectSHA512,'hex').toString('base64'),integrity)
  assert.match(notice.text,/2024-present VoidZero Inc/)
  assert.ok(notice.source.includes('/'+notice.revision+'/LICENSE'))
  assert.match(notice.revisionEvidence,/signature not independently verified/)
})

test('supplemental attribution binds the installed package and exact upstream revision',()=>{
  const directory=packageFixture('napi-runtime-1.2.4')
  const manifest=JSON.parse(readFileSync(join(directory,'package.json')))
  const notice=supplementalPackageNotice(directory,manifest)
  assert.match(notice.text,/Copyright \(c\) 2020-present LongYinan/)
  assert.match(notice.text,/Copyright \(c\) 2018 GitHub/)
  assert.ok(notice.source.includes('/'+notice.revision+'/LICENSE'))
  assert.equal(notice.revisionEvidence,'npm @napi-rs/wasm-runtime@1.2.4 gitHead')
  const changed=mkdtempSync(join(tmpdir(),'supplemental-notice-'))
  writeFileSync(join(changed,'package.json'),JSON.stringify({...manifest,license:'changed'}))
  assert.throws(()=>supplementalPackageNotice(changed,manifest),/package identity changed/)
  assert.equal(supplementalPackageNotice(changed,{...manifest,version:'1.2.5'}),undefined)
})

test('both bundled Lightning CSS versions retain the pinned upstream MPL text',()=>{
  const notices=[]
  for(const name of ['lightningcss-wasm-132','lightningcss-wasm']){
    const directory=dirname(require.resolve(name+'/lightningcss_node.wasm'))
    const manifest=JSON.parse(readFileSync(join(directory,'package.json')))
    const notice=supplementalPackageNotice(directory,manifest)
    assert.ok(notice)
    assert.match(notice.text,/Mozilla Public License Version 2\.0/)
    assert.ok(notice.source.includes('/'+notice.revision+'/LICENSE'))
    assert.equal(notice.revisionEvidence,`npm ${manifest.name}@${manifest.version} gitHead`)
    notices.push(notice)
  }
  assert.equal(notices[0].sha256,notices[1].sha256)
  assert.notEqual(notices[0].revision,notices[1].revision)
})

test('bundled wasm-util preserves the actual maintainer notice and its later source date',()=>{
  const directory=packageFixture('wasm-util-0.10.2')
  const manifest=JSON.parse(readFileSync(join(directory,'package.json')))
  const notice=supplementalPackageNotice(directory,manifest)
  assert.match(notice.text,/Copyright \(c\) 2022-present Toyobayashi/)
  assert.equal(notice.releaseRevision,'cded8e894fe40c7c6200a3fdb2bd33e328b7bb65')
  assert.equal(notice.revision,'a16b188d44ae43cc91edb71996ba2b43ff0996d9')
  assert.match(notice.revisionEvidence,/not a license file shipped in that release/)
})

test('declared Apache license includes official terms and the original package attribution',()=>{
  const directory='node_modules/glob-to-regex.js',manifest=JSON.parse(readFileSync(join(directory,'package.json')))
  const notice=supplementalPackageNotice(directory,manifest)
  assert.match(notice.text,/^Apache-2\.0 © streamich/)
  assert.match(notice.text,/Apache License\s+Version 2\.0, January 2004/)
  assert.equal(notice.source,'https://www.apache.org/licenses/LICENSE-2.0.txt')
  const changed=mkdtempSync(join(tmpdir(),'apache-package-attribution-test-'))
  writeFileSync(join(changed,'package.json'),readFileSync(join(directory,'package.json')))
  writeFileSync(join(changed,'README.md'),'Apache-2.0 © Someone Else')
  assert.throws(()=>supplementalPackageNotice(changed,manifest),/attribution changed/)
})
