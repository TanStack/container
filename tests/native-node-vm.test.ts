import {expect,test} from 'vitest'
import {Script,runInThisContext,runInContext,runInNewContext,createContext} from '../src/vite-browser/node-vm'
import {Script as NativeScript,runInThisContext as nativeRunInThisContext} from 'node:vm'
import {enableBrowserSourceLocations,workerSourceLocations} from '../src/native/browser-source-locations'
import {probeVMFunctionIdentity,probeVMFunctionSource} from './fixtures/native-vm-function-identity.mjs'
import {vmCompletionSources} from './fixtures/native-vm-completions.mjs'

test.each(vmCompletionSources)('script completion matches Node for %s',source=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'owned')
  try{
    const expected=new NativeScript(source).runInNewContext()
    expect(new Script(source,{filename:'/app/completion.js'}).runInThisContext()).toEqual(expected)
  }finally{
    if(previous)Object.defineProperty(globalThis,'owned',previous)
    else delete (globalThis as any).owned
  }
})

test('async VM functions keep their own identity, including recursion and direct eval',async()=>{
  enableBrowserSourceLocations()
  expect(await probeVMFunctionIdentity(Script)).toEqual(await probeVMFunctionIdentity(NativeScript))
})

test('VM compilation preserves untouched function source exactly',()=>{
  enableBrowserSourceLocations()
  expect(probeVMFunctionSource(Script)).toEqual(probeVMFunctionSource(NativeScript))
})

test('invalid VM execution options match Node without executing the script',()=>{
  for(const options of [null,42,'x',{timeout:null},{timeout:'1'},{timeout:0},{timeout:1.5},
    {timeout:NaN},{timeout:Infinity},{timeout:4294967296},{breakOnSigint:null},{breakOnSigint:1}]){
    const failure=(Constructor:any)=>{
      try{new Constructor('42').runInThisContext(options);return null}
      catch(error){return {name:(error as Error).name,code:(error as any).code}}
    }
    expect(failure(Script)).toEqual(failure(NativeScript))
    expect(failure(Script)).not.toBeNull()
  }
})

test('unsupported execution limits fail explicitly at every VM entry point',()=>{
  const key='__containerVmUnsupportedLimitProbe'
  const source=`globalThis.${key}=true`
  for(const options of [{timeout:1},{timeout:4294967295},{breakOnSigint:true}]){
    for(const evaluate of [
      ()=>new Script(source).runInThisContext(options),
      ()=>new Script(source).runInContext(createContext({}),options),
      ()=>new Script(source).runInNewContext({},options),
      ()=>runInThisContext(source,options),
      ()=>runInContext(source,createContext({}),options),
      ()=>runInNewContext(source,{},options),
    ])expect(evaluate).toThrow(expect.objectContaining({code:'ERR_NOT_IMPLEMENTED'}))
    expect((globalThis as any)[key]).toBeUndefined()
  }
  expect(new Script('42').runInThisContext({breakOnSigint:false})).toBe(42)
})

test('script filenames identify callers in evaluated functions',()=>{
  for(const evaluate of [()=>runInThisContext('(()=>new Error().stack)',{filename:'/app/caller.js'}),
    ()=>new Script('(()=>new Error().stack)',{filename:'/app/caller.js'}).runInThisContext()]){
    expect(evaluate()()).toContain('/app/caller.js')
  }
})

test('script option validation matches Node with and without a filename',()=>{
  const invalid=[null,42,{filename:42},{lineOffset:1.5},{columnOffset:1.5},
    {lineOffset:2147483648},{columnOffset:-2147483649},{lineOffset:null},{columnOffset:'1'}]
  for(const options of invalid){
    const failure=(Constructor:any)=>{
      try{new Constructor('42',options);return null}
      catch(error){return {name:(error as Error).name,code:(error as any).code}}
    }
    expect(failure(Script)).toEqual(failure(NativeScript))
    expect(failure(Script)).not.toBeNull()
  }
  for(const options of [undefined,'/app/owned.js',{}, {lineOffset:-2147483648,columnOffset:2147483647}])
    expect(new Script('42',options).runInThisContext()).toBe(new NativeScript('42',options).runInThisContext())
})

test('registered VM script offsets match Node and inline maps restore original lines',()=>{
  enableBrowserSourceLocations()
  const source='(()=>new Error("owned").stack)'
  const options={filename:'/app/offset.js',lineOffset:2,columnOffset:3}
  const native=nativeRunInThisContext(source,options)()
  const mapped=workerSourceLocations.mapStack(runInThisContext(source,options)())
  expect(mapped.match(/\/app\/offset\.js:(\d+):(\d+)/)?.slice(1)).toEqual(native.match(/\/app\/offset\.js:(\d+):(\d+)/)?.slice(1))
  const map={version:3,sources:['original.js'],names:[],mappings:';AAAA',sourcesContent:[source]}
  const code='// generated prelude\n'+source+'\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(map)).toString('base64')
  const restored=workerSourceLocations.mapStack(runInThisContext(code,{filename:'/app/generated.js'})())
  expect(restored).toContain('/app/original.js:1:1')
})
test('a filename cannot inject another source line',()=>{
  expect(()=>runInThisContext('42',{filename:'test.js\nthrow new Error()'})).toThrow(TypeError)
})

test('runInThisContext uses the global receiver and preserves global declarations',()=>{
  const key='__containerVmGlobalDeclarationProbe'
  try{
    expect(runInThisContext('this===globalThis')).toBe(true)
    expect(runInThisContext(`var ${key}=41;${key}`)).toBe(41)
    expect(runInThisContext(`${key}+1`)).toBe(42)
  }finally{delete (globalThis as Record<string,unknown>)[key]}
})

test('VM async generators match Node iteration, receiver and self identity',async()=>{
  enableBrowserSourceLocations()
  const source='(async function* values(extra=2){yield this.value+extra;yield values;return 7})'
  const options={filename:'/app/async-generator.js'}
  const actual=new Script(source,options).runInThisContext()
  const reference=nativeRunInThisContext(source,options)
  expect(actual.name).toBe(reference.name)
  expect(actual.length).toBe(reference.length)
  const actualIterator=actual.call({value:40})
  const referenceIterator=reference.call({value:40})
  expect(actualIterator[Symbol.asyncIterator]()).toBe(actualIterator)
  expect(await actualIterator.next()).toEqual(await referenceIterator.next())
  expect((await actualIterator.next()).value).toBe(actual)
  expect((await referenceIterator.next()).value).toBe(reference)
  expect(await actualIterator.next()).toEqual(await referenceIterator.next())
})
