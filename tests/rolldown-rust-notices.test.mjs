import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {writeRolldownRustNotices} from '../scripts/rolldown-rust-notices.mjs'

test('writes revision-bound Rolldown Rust notices and preserves unresolved records',()=>{
  const out=mkdtempSync(join(tmpdir(),'rolldown-rust-sdk-notices-')),result=writeRolldownRustNotices(out)
  assert.equal(result.complete,false)
  assert.equal(result.evidence.coveredMissingNoticeRecords.length,43)
  assert.deepEqual(result.evidence.unresolvedMissingNoticeRecords,['base-encode@0.3.1','escape-simd@0.1.0','json-escape-simd@3.1.2','typedmap@0.6.0'])
  assert.equal(result.evidence.exactLinkedContents,false)
  assert.equal(result.notices.length,15)
  assert.equal(result.evidence.packageNoticeTexts.uniqueTexts,134)
  assert.equal(result.evidence.packageNoticeTexts.attributions,391)
  for(const path of result.notices){
    const bytes=readFileSync(join(out,path.slice('licenses/'.length)))
    if(path===result.path)assert.equal(createHash('sha256').update(bytes).digest('hex'),result.sha256)
  }
  assert.equal(readdirSync(out).length,15)
})
