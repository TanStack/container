import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {WorkspaceFiles} from '../src/sandbox/files'
import {rolldownBindingArtifact,prepareRolldownBindingArtifact} from '../src/compiler/rolldown-binding-artifact'

const root='/project/node_modules/@rolldown/binding-wasm32-wasi'
const entry=root+'/'+rolldownBindingArtifact.entry
function workspace(){return new WorkspaceFiles(Object.fromEntries(Object.keys(rolldownBindingArtifact.hashes).map(name=>[root+'/'+name,new Uint8Array(readFileSync('tests/fixtures/rolldown-native-probe/node_modules/@rolldown/binding-wasm32-wasi/'+name))])))}

test('selects pinned binding without modifying installed files',async()=>{
  const files=workspace()
  try{
    const before=files.readFileSync(entry)
    const result=await prepareRolldownBindingArtifact(files,entry)
    expect(result).toMatchObject({entry,version:'1.2.9',sourceSHA256:rolldownBindingArtifact.hashes['rolldown-binding.wasi.cjs']})
    expect(result.source).toBe(new TextDecoder().decode(before))
    expect(files.readFileSync(entry)).toEqual(before)
  }finally{files.close()}
})

test.each(['package.json','rolldown-binding.wasi.cjs'])('rejects changed %s instead of selecting by package name',async name=>{
  const files=workspace()
  try{
    files.writeFileSync(root+'/'+name,new TextEncoder().encode('changed'))
    await expect(prepareRolldownBindingArtifact(files,entry)).rejects.toThrow('Unsupported Rolldown binding artifact: '+name)
  }finally{files.close()}
})

test('returns captured source, not later workspace edits',async()=>{
  const files=workspace()
  try{
    const original=new TextDecoder().decode(files.readFileSync(entry))
    const pending=prepareRolldownBindingArtifact(files,entry)
    files.writeFileSync(entry,new TextEncoder().encode('changed'))
    expect((await pending).source).toBe(original)
    expect(new TextDecoder().decode(files.readFileSync(entry))).toBe('changed')
  }finally{files.close()}
})
