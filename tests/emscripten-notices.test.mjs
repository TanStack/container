import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {writeEmscriptenNotices} from '../scripts/emscripten-notices.mjs'

test('ships pinned compiler runtime notices with content and upstream identities',()=>{
  const directory=mkdtempSync(join(tmpdir(),'emscripten-notices-'))
  const result=writeEmscriptenNotices(directory,{engine:{metadata:{sdk:'5.0.1'}}})
  assert.equal(result.revision,'8c5f43157a3f069ade75876e23061330521eabde')
  assert.equal(result.notices.length,3)
  for(const notice of result.notices){
    const bytes=readFileSync(join(directory,notice.path.slice('licenses/'.length)))
    assert.equal(createHash('sha256').update(bytes).digest('hex'),notice.sha256)
    assert.equal(bytes.length,notice.bytes)
    assert.ok(notice.url.includes('/'+result.revision+'/'))
  }
  assert.match(readFileSync(join(directory,'emscripten-5.0.1-LICENSE'),'utf8'),/Emscripten authors/)
  assert.match(readFileSync(join(directory,'emscripten-5.0.1-musl-COPYRIGHT'),'utf8'),/Rich Felker/)
  assert.match(readFileSync(join(directory,'emscripten-5.0.1-compiler-rt-LICENSE'),'utf8'),/LLVM Exceptions/)
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'EMSCRIPTEN-NOTICE-EVIDENCE.json'))),result)
})

test('refuses attribution for a different compiler before writing notices',()=>{
  const directory=mkdtempSync(join(tmpdir(),'emscripten-notices-mismatch-'))
  assert.throws(()=>writeEmscriptenNotices(directory,{engine:{metadata:{sdk:'6.0.0'}}}),/notice version differs/)
  assert.deepEqual(readdirSync(directory),[])
})
