import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {pathToFileURL} from 'node:url'
import {writeRustWASISysrootNotices} from '../scripts/rust-wasi-sysroot-notices.mjs'

const binding={version:'1.2.9',wasmSHA256:'629aa10c37a9920cd5729a35af148983c881f4ff9edd6368a7d63b5acbf89dc2'}

test('ships hash-bound Rust 1.98.1 and WASI SDK 33 notices',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rust-wasi-notices-'))
  const result=writeRustWASISysrootNotices(directory,binding)
  assert.equal(result.evidence.rust.version,'1.98.1')
  assert.equal(result.evidence.rust.revision,'48a229ceaefd4985c50990b14116b6d856af0985')
  assert.equal(result.evidence.rust.standardLibraryArchive.target,'wasm32-wasip1-threads')
  assert.equal(result.evidence.wasiSDK.revision,'c10c0507deb3e5aad506f1f9f32084e49a21834b')
  assert.equal(result.evidence.wasiSDK.wasiLibcRevision,'161b3195fc2558d2b1ba3eb9ffae3b2b47407623')
  assert.equal(result.evidence.wasiSDK.llvmRevision,'4434dabb69916856b824f68a64b029c67175e532')
  assert.equal(result.evidence.complete,false)
  assert.equal(result.evidence.exactLinkedContents,false)
  assert.equal(result.notices.length,12)
  for(const notice of result.notices){
    const bytes=readFileSync(join(directory,notice.path.slice('licenses/'.length)))
    assert.equal(createHash('sha256').update(bytes).digest('hex'),notice.sha256)
    assert.equal(bytes.length,notice.bytes)
  }
  assert.match(readFileSync(join(directory,'rust-1.98.1-COPYRIGHT-library.html'),'utf8'),/Copyright notices for The Rust Standard Library/)
  assert.match(readFileSync(join(directory,'wasi-libc-161b3195-LICENSE'),'utf8'),/third-party works covered by\s+their own licenses/)
  assert.match(readFileSync(join(directory,'llvm-4434dabb-LICENSE.txt'),'utf8'),/LLVM Exceptions/)
  assert.deepEqual(JSON.parse(readFileSync(join(directory,'RUST-WASI-SYSROOT-NOTICE-EVIDENCE.json'))),result.evidence)
})

for(const [name,value,message] of [
  ['version',{...binding,version:'1.2.8'},/version differs/],
  ['WASM hash',{...binding,wasmSHA256:'0'.repeat(64)},/hash differs/],
])test('refuses a mismatched Rolldown '+name+' before writing notices',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rust-wasi-notices-mismatch-'))
  assert.throws(()=>writeRustWASISysrootNotices(directory,value),message)
  assert.deepEqual(readdirSync(directory),[])
})

test('rejects changed notice bytes before writing any output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rust-wasi-notices-changed-'))
  const directory=join(root,'output')
  mkdirSync(directory)
  mkdirSync(join(root,'scripts'))
  mkdirSync(join(root,'licenses','upstream'),{recursive:true})
  const descriptor='licenses/upstream/rust-1.98.1-wasi-notices.json'
  const record=JSON.parse(readFileSync(descriptor))
  for(const path of [descriptor,...record.notices.map(item=>item.path)])cpSync(path,join(root,path))
  const changed=join(root,record.notices.at(-1).path)
  writeFileSync(changed,readFileSync(changed,'utf8')+'\nchanged\n')
  const script=join(root,'scripts','rust-wasi-sysroot-notices.mjs')
  cpSync('scripts/rust-wasi-sysroot-notices.mjs',script)
  const {writeRustWASISysrootNotices:writeCopiedNotices}=await import(pathToFileURL(script).href)
  assert.throws(()=>writeCopiedNotices(directory,binding),/Rust WASI notice changed/)
  assert.deepEqual(readdirSync(directory),[])
})
