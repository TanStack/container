import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {basename,join} from 'node:path'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

export function writeRustWASISysrootNotices(directory,binding){
  const record=JSON.parse(readFileSync(new URL('../licenses/upstream/rust-1.98.1-wasi-notices.json',import.meta.url)))
  assert.equal(binding?.version,record.rolldown.version,'Rust WASI notice Rolldown version differs from binding')
  assert.equal(binding?.wasmSHA256,record.rolldown.bindingWasmSHA256,'Rust WASI notice binding hash differs from shipped WASM')
  const notices=record.notices.map(item=>{
    const bytes=readFileSync(new URL('../'+item.path,import.meta.url))
    assert.equal(hash(bytes),item.sha256,`Rust WASI notice changed: ${item.path}`)
    return {...item,name:basename(item.path),bytes}
  })
  for(const notice of notices)writeFileSync(join(directory,notice.name),notice.bytes)
  const evidence={...record,complete:false,exactLinkedContents:false,notices:notices.map(({bytes,name,...item})=>({...item,path:'licenses/'+name,bytes:bytes.length}))}
  const json=JSON.stringify(evidence,null,2)+'\n'
  const path='licenses/RUST-WASI-SYSROOT-NOTICE-EVIDENCE.json'
  writeFileSync(join(directory,basename(path)),json)
  return {path,sha256:hash(json),notices:evidence.notices,evidence}
}
