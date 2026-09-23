import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

const input=process.argv[2]??'reports/firefox-interpreter-profile.json'
const output=process.argv[3]??'reports/firefox-interpreter-profile-summary.json'
if(input===output)throw Error('Profile and summary paths must differ')
const bytes=readFileSync(input),profile=JSON.parse(bytes)
const threads=[]
function visit(process){
  for(const thread of process.threads??[]){
    if(thread.name!=='DOM Worker')continue
    const counts=new Map()
    const inclusive=new Map()
    const wasmLeafCounts=new Map()
    let sampled=0
    for(const sample of thread.samples.data){
      const stack=sample[thread.samples.schema.stack]
      if(stack==null)continue
      const frame=thread.stackTable.data[stack][thread.stackTable.schema.frame]
      const name=thread.stringTable[thread.frameTable.data[frame][thread.frameTable.schema.location]]
      counts.set(name,(counts.get(name)??0)+1);sampled++
      const wasmName=location=>location.startsWith('engine.wasm.')?location.slice('engine.wasm.'.length).split(' (')[0]:undefined
      const leaf=wasmName(name)
      if(leaf)wasmLeafCounts.set(leaf,(wasmLeafCounts.get(leaf)??0)+1)
      // Count recursive functions once per sample, not once per frame.
      const present=new Set()
      let cursor=stack
      while(cursor!=null){
        const entry=thread.stackTable.data[cursor]
        const frame=thread.frameTable.data[entry[thread.stackTable.schema.frame]]
        const fn=wasmName(thread.stringTable[frame[thread.frameTable.schema.location]])
        if(fn)present.add(fn)
        cursor=entry[thread.stackTable.schema.prefix]
      }
      for(const fn of present)inclusive.set(fn,(inclusive.get(fn)??0)+1)
    }
    if(![...counts.keys()].some(name=>name.includes('engine.wasm.')))continue
    threads.push({tid:thread.tid,name:thread.name,sampled,
      wasmLeafSamples:[...wasmLeafCounts].sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count})),
      inclusiveWasmSamples:[...inclusive].sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count})),
      leafSamples:[...counts].sort((a,b)=>b[1]-a[1]).map(([location,count])=>({location,count}))})
  }
  for(const child of process.processes??[])visit(child)
}
visit(profile)
if(!threads.length)throw Error('No DOM Worker samples with engine WASM names found')
const result={input,sha256:createHash('sha256').update(bytes).digest('hex'),
  scope:'Sample counts, not exact function durations. Inclusive counts deduplicate recursion per sample and overlap across functions. Includes startup and idle samples; no native symbol download or upload.',threads}
writeFileSync(output,JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({...result,threads:threads.map(thread=>({...thread,leafSamples:thread.leafSamples.slice(0,12),wasmLeafSamples:thread.wasmLeafSamples.slice(0,12),inclusiveWasmSamples:thread.inclusiveWasmSamples.slice(0,12)}))},null,2))
