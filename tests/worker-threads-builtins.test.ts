import {it,expect} from 'vitest'
import {buildSync,transformSync} from 'esbuild'
import {builtinModules} from '../src/compiler/builtins'

it('emits the supported worker_threads surface as a valid builtin',()=>{
  const source=builtinModules['node:worker_threads']
  const metadata=buildSync({stdin:{contents:source},write:false,format:'esm',metafile:true})
  const exports=Object.values(metadata.metafile!.outputs)[0].exports
  for(const name of ['Worker','isMainThread','threadId','workerData','parentPort','SHARE_ENV','MessageChannel','MessagePort','receiveMessageOnPort','default'])expect(exports).toContain(name)
  expect(()=>transformSync(source,{format:'cjs',target:'es2022'})).not.toThrow()
})

it('uses a dedicated runtime transport instead of child_process or local MessageChannel',()=>{
  const source=builtinModules['node:worker_threads']
  expect(source).toContain("host.proc.call('workerSpawn'")
  expect(source).toContain("host.proc.call('workerSend'")
  expect(source).toContain('host.proc.workerNext')
  expect(source).not.toContain("from 'node:child_process'")
  expect(source).not.toContain('new MessageChannel')
})
