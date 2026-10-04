import {afterEach,expect,it} from 'vitest'
import {disposeBrowserRolldown} from '../src/native/browser-rolldown-lifecycle'

const bindingKey=Symbol.for('web-container:rolldown-binding')
const disposeKey=Symbol.for('napi.rs.wasi.dispose')
const registry=globalThis as typeof globalThis & {[key:symbol]:unknown}
const original=registry[bindingKey]

afterEach(()=>{
  if(original===undefined)delete registry[bindingKey]
  else registry[bindingKey]=original
})

it('awaits browser WASI disposal and clears the binding handle',async()=>{
  let finish!:()=>void
  const pending=new Promise<void>(resolve=>{finish=resolve})
  const binding={[disposeKey]:()=>pending}
  registry[bindingKey]=binding
  let settled=false
  const disposal=disposeBrowserRolldown().then(()=>{settled=true})
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(registry[bindingKey]).toBe(binding)
  finish()
  await disposal
  expect(registry[bindingKey]).toBeUndefined()
  await expect(disposeBrowserRolldown()).resolves.toBeUndefined()
})

it('keeps the binding handle when disposal fails',async()=>{
  const binding={[disposeKey]:()=>Promise.reject(Error('cleanup failed'))}
  registry[bindingKey]=binding
  await expect(disposeBrowserRolldown()).rejects.toThrow('cleanup failed')
  expect(registry[bindingKey]).toBe(binding)
})
