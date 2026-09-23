import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {basename,join} from 'node:path'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

export function writeEmscriptenNotices(directory,engines={}){
  const record=JSON.parse(readFileSync(new URL('../licenses/upstream/emscripten-5.0.1-notices.json',import.meta.url)))
  for(const [slot,engine] of Object.entries(engines))assert.equal(engine.metadata?.sdk,record.version,`Emscripten notice version differs from engine ${slot}`)
  const notices=record.notices.map(item=>{
    const bytes=readFileSync(new URL('../'+item.path,import.meta.url))
    assert.equal(hash(bytes),item.sha256,`Emscripten notice changed: ${item.path}`)
    const name=basename(item.path)
    writeFileSync(join(directory,name),bytes)
    return {...item,path:'licenses/'+name,bytes:bytes.length}
  })
  const shipped={...record,notices}
  writeFileSync(join(directory,'EMSCRIPTEN-NOTICE-EVIDENCE.json'),JSON.stringify(shipped,null,2)+'\n')
  return shipped
}
