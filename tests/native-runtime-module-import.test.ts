import {expect,it,vi} from 'vitest'
import {importRuntimeModule,setRuntimeWorkspaceImporter} from '../src/native/runtime-module-import'

it('routes generated file URLs and workspace paths through the configured loader',async()=>{
  const loader=vi.fn(async value=>({value}))
  setRuntimeWorkspaceImporter(loader)
  await expect(importRuntimeModule('file:///app/node_modules/.vite-temp/config.mjs')).resolves.toEqual({value:'file:///app/node_modules/.vite-temp/config.mjs'})
  await expect(importRuntimeModule('/app/main.js')).resolves.toEqual({value:'/app/main.js'})
  expect(loader).toHaveBeenCalledTimes(2)
})

it('keeps browser imports native and does not silently discard workspace import attributes',async()=>{
  const imported=await importRuntimeModule('data:text/javascript,export default 42') as {default:number}
  expect(imported.default).toBe(42)
  await expect(importRuntimeModule('/app/config.json',{with:{type:'json'}})).rejects.toThrow('attributes')
})
