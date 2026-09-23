import {it,expect,vi} from 'vitest'
import type {QuickJSContext} from 'quickjs-emscripten-core'
import {initializeTrustedWebAPIs} from '../src/sandbox/trusted-initializer'

function context(failure=false){
  let live=0
  const handle=(value:unknown)=>{live++;return {value,dispose(){live--}}}
  const result=()=>handle(undefined)
  const api={
    newString:(source:string)=>handle(source),newArrayBuffer:(bytes:ArrayBuffer)=>handle(bytes),
    compileTrustedInitializer:vi.fn(()=>handle(new Uint8Array([1,2]))),
    evalTrustedInitializer:vi.fn(()=>{if(failure)throw Error('evaluation failed');return result()}),
    getArrayBuffer:(compiled:{value:unknown})=>handle(compiled.value),
    unwrapResult:(value:unknown)=>value,evalCode:vi.fn(result),
  }
  return {api,cast:api as unknown as QuickJSContext,live:()=>live}
}
it('uses source evaluation when the candidate methods are absent',()=>{
  const fixture=context(),{compileTrustedInitializer,evalTrustedInitializer,...api}=fixture.api
  expect(initializeTrustedWebAPIs({},api as unknown as QuickJSContext,'source')).toEqual({compiled:false,retainedBytes:0})
  expect(api.evalCode).toHaveBeenCalledWith('source','web-apis.js');expect(fixture.live()).toBe(0)
})
it('reuses bytes for fresh contexts belonging to one engine and releases handles',()=>{
  const engine={},first=context(),second=context()
  expect(initializeTrustedWebAPIs(engine,first.cast,'source')).toEqual({compiled:true,retainedBytes:2})
  initializeTrustedWebAPIs(engine,second.cast,'source')
  expect(first.api.compileTrustedInitializer).toHaveBeenCalledTimes(1)
  expect(second.api.compileTrustedInitializer).not.toHaveBeenCalled()
  expect(second.api.evalTrustedInitializer).toHaveBeenCalledTimes(1)
  expect(first.live()).toBe(0);expect(second.live()).toBe(0)
})
it('does not reuse compiled bytes across engine identities',()=>{
  const first=context(),second=context()
  initializeTrustedWebAPIs({},first.cast,'source');initializeTrustedWebAPIs({},second.cast,'source')
  expect(first.api.compileTrustedInitializer).toHaveBeenCalledTimes(1)
  expect(second.api.compileTrustedInitializer).toHaveBeenCalledTimes(1)
})
it('releases temporary handles when evaluation fails',()=>{
  const fixture=context(true)
  expect(()=>initializeTrustedWebAPIs({},fixture.cast,'source')).toThrow('evaluation failed')
  expect(fixture.live()).toBe(0)
})
