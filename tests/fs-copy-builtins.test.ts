import {it,expect} from 'vitest'
import {transformSync,buildSync} from 'esbuild'
import {builtinModules} from '../src/compiler/builtins'

it('emitted fs facade exposes named and default copy APIs',()=>{
  for(const [name,keys]of [['node:fs',['cp','cpSync']],['node:fs/promises',['cp']]] as const){
    const source=builtinModules[name]
    const metadata=buildSync({stdin:{contents:source},write:false,format:'esm',metafile:true})
    const exports=Object.values(metadata.metafile!.outputs)[0].exports
    for(const key of keys)expect(exports).toContain(key)
    expect(source).toMatch(/export default \{[^}]*\bcp,/s)
    expect(()=>transformSync(source,{format:'cjs',target:'es2022'})).not.toThrow()
  }
})

it('promise facade delegates callback copy errors and completion without Node ambient imports',async()=>{
  // Evaluate the actual emitted promise wrapper independently of unrelated fs
  // descriptors, preserving its function body and callback forwarding.
  const source=builtinModules['node:fs/promises']
  const statement=source.match(/export const cp=([^\n]+);/)![1]
  const received:unknown[][]=[]
  const success=new Function('copyWithCallback','return '+statement)((...args:unknown[])=>{
    received.push(args.slice(0,3));(args[3] as (error?:Error)=>void)()
  })
  expect(await success('source','destination',{recursive:true})).toBeUndefined()
  expect(received).toEqual([['source','destination',{recursive:true}]])
  const reason=Error('copy failed')
  const failure=new Function('copyWithCallback','return '+statement)((...args:unknown[])=>(args[3] as (error:Error)=>void)(reason))
  await expect(failure('a','b')).rejects.toBe(reason)
})
