import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {supplementalPackageNotice} from '../scripts/supplemental-package-notices.mjs'

test('parser notice matches the registry provenance subject and pinned source',()=>{
  const directory='tests/fixtures/rolldown-native-probe/node_modules/@rolldown/binding-wasm32-wasi'
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
  const directory='tests/fixtures/rolldown-native-probe/node_modules/@napi-rs/wasm-runtime'
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
