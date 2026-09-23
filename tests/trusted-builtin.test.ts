import {it,expect,vi} from 'vitest'
import type {QuickJSContext} from 'quickjs-emscripten-core'
import {compileTrustedProcessBuiltin,compileTrustedInspectionInitializer} from '../src/sandbox/trusted-builtin'

function disposeSuccess(result:ReturnType<typeof compileTrustedProcessBuiltin>){
  if('error' in result)throw Error('Expected a successful wrapper result')
  result.value.dispose()
}

function fixture(){
  let live=0
  const handle=(value:unknown)=>{live++;let disposed=false;return {value,dispose(){expect(disposed).toBe(false);disposed=true;live--}}}
  const result=()=>({value:handle({})})
  const api={
    newString:vi.fn((value:string)=>handle(value)),
    newArrayBuffer:vi.fn((value:ArrayBuffer)=>handle(value)),
    compileTrustedInitializerWithFilename:vi.fn((_source:unknown,_filename:unknown)=>({value:handle(new Uint8Array([1,2]))})),
    evalTrustedInitializer:vi.fn(result),
    evalCode:vi.fn(result),
    getArrayBuffer:vi.fn((value:{value:unknown})=>handle(value.value)),
    unwrapResult:vi.fn((value:{value?:unknown,error?:unknown})=>{if(value.error)throw value.error;return value.value}),
  }
  return {api,context:api as unknown as QuickJSContext,live:()=>live}
}

it('caches inspection independently and evaluates a fresh initializer in every context',()=>{
  const engine={},first=fixture(),second=fixture()
  disposeSuccess(compileTrustedProcessBuiltin(engine,first.context,'process wrapper'))
  const a=compileTrustedInspectionInitializer(engine,first.context,'inspection wrapper')
  const b=compileTrustedInspectionInitializer(engine,second.context,'inspection wrapper')
  expect(first.api.compileTrustedInitializerWithFilename).toHaveBeenCalledTimes(2)
  expect(second.api.compileTrustedInitializerWithFilename).not.toHaveBeenCalled()
  expect(second.api.evalTrustedInitializer).toHaveBeenCalledTimes(1)
  expect(a).not.toBe(b)
  const [source,filename]=first.api.compileTrustedInitializerWithFilename.mock.calls[1] as [{value:string},{value:string}]
  expect(source.value).toBe('inspection wrapper')
  expect(filename.value).toBe('inspection-initializer.js')
  disposeSuccess(a);disposeSuccess(b)
  expect(first.live()).toBe(0);expect(second.live()).toBe(0)
  expect(()=>compileTrustedInspectionInitializer(engine,second.context,'changed')).toThrow('source is already fixed')
  disposeSuccess(compileTrustedInspectionInitializer({},second.context,'inspection wrapper'))
  expect(second.api.compileTrustedInitializerWithFilename).toHaveBeenCalledTimes(1)
  expect(second.live()).toBe(0)
})

it.each(['compileTrustedInitializerWithFilename','evalTrustedInitializer'] as const)('inspection falls back with its fixed filename when %s is absent',missing=>{
  const f=fixture(),context={...f.api,[missing]:undefined} as unknown as QuickJSContext
  disposeSuccess(compileTrustedInspectionInitializer({},context,'inspection wrapper'))
  expect(f.api.evalCode).toHaveBeenCalledWith('inspection wrapper','inspection-initializer.js')
  expect(f.api.compileTrustedInitializerWithFilename).not.toHaveBeenCalled()
  expect(f.live()).toBe(0)
})

it('compiles once per engine but returns a fresh context-owned wrapper each time',()=>{
  const engine={},first=fixture(),second=fixture()
  const a=compileTrustedProcessBuiltin(engine,first.context,'wrapper')
  const b=compileTrustedProcessBuiltin(engine,second.context,'wrapper')
  expect(first.api.compileTrustedInitializerWithFilename).toHaveBeenCalledTimes(1)
  expect(second.api.compileTrustedInitializerWithFilename).not.toHaveBeenCalled()
  expect(first.api.evalTrustedInitializer).toHaveBeenCalledTimes(1)
  expect(second.api.evalTrustedInitializer).toHaveBeenCalledTimes(1)
  expect(a).not.toBe(b)
  expect(first.live()).toBe(1);expect(second.live()).toBe(1)
  disposeSuccess(a);disposeSuccess(b)
  expect(first.live()).toBe(0);expect(second.live()).toBe(0)
})

it('keeps the trusted source and filename fixed without sharing across engines',()=>{
  const engine={},first=fixture(),second=fixture()
  disposeSuccess(compileTrustedProcessBuiltin(engine,first.context,'wrapper'))
  const [source,filename]=first.api.compileTrustedInitializerWithFilename.mock.calls[0] as [{value:string},{value:string}]
  expect(source.value).toBe('wrapper');expect(filename.value).toBe('node:process')
  expect(()=>compileTrustedProcessBuiltin(engine,second.context,'changed')).toThrow('source is already fixed')
  expect(second.live()).toBe(0)
  disposeSuccess(compileTrustedProcessBuiltin({},second.context,'wrapper'))
  expect(second.api.compileTrustedInitializerWithFilename).toHaveBeenCalledTimes(1)
})

it.each(['compileTrustedInitializerWithFilename','evalTrustedInitializer'] as const)('falls back when %s is unavailable',missing=>{
  const f=fixture(),api={...f.api,[missing]:undefined}
  const result=compileTrustedProcessBuiltin({},api as unknown as QuickJSContext,'wrapper')
  expect(f.api.evalCode).toHaveBeenCalledWith('wrapper','node:process')
  expect(f.api.compileTrustedInitializerWithFilename).not.toHaveBeenCalled()
  expect(result).toBe(f.api.evalCode.mock.results[0].value)
  disposeSuccess(result);expect(f.live()).toBe(0)
})

it('releases compile inputs on failure and retries without retaining partial bytes',()=>{
  const engine={},f=fixture()
  f.api.compileTrustedInitializerWithFilename.mockImplementationOnce(()=>{throw Error('compile failed')})
  expect(()=>compileTrustedProcessBuiltin(engine,f.context,'wrapper')).toThrow('compile failed')
  expect(f.live()).toBe(0)
  disposeSuccess(compileTrustedProcessBuiltin(engine,f.context,'wrapper'))
  expect(f.api.compileTrustedInitializerWithFilename).toHaveBeenCalledTimes(2)
  expect(f.live()).toBe(0)
})

it('releases compiled handles if reading bytecode fails',()=>{
  const f=fixture()
  f.api.getArrayBuffer.mockImplementationOnce(()=>{throw Error('read failed')})
  expect(()=>compileTrustedProcessBuiltin({},f.context,'wrapper')).toThrow('read failed')
  expect(f.live()).toBe(0)
})

it('releases evaluation input on throws while retaining valid compiled bytes',()=>{
  const engine={},f=fixture()
  f.api.evalTrustedInitializer.mockImplementationOnce(()=>{throw Error('evaluation failed')})
  expect(()=>compileTrustedProcessBuiltin(engine,f.context,'wrapper')).toThrow('evaluation failed')
  expect(f.live()).toBe(0)
  disposeSuccess(compileTrustedProcessBuiltin(engine,f.context,'wrapper'))
  expect(f.api.compileTrustedInitializerWithFilename).toHaveBeenCalledTimes(1)
  expect(f.live()).toBe(0)
})

it('returns evaluation error results unchanged for the caller to own',()=>{
  const f=fixture(),errorResult={error:{dispose:vi.fn()}}
  f.api.evalTrustedInitializer.mockReturnValueOnce(errorResult as never)
  expect(compileTrustedProcessBuiltin({},f.context,'wrapper')).toBe(errorResult)
  expect(errorResult.error.dispose).not.toHaveBeenCalled()
  expect(f.live()).toBe(0)
})
