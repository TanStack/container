import {expect,test} from 'vitest'
import {callableWorkspaceLimits,restoreCallableDescriptor,validateCallableHookArguments} from '../src/compiler/rolldown-callable-protocol'
test('Vite load SSR options and transform options are preserved unchanged',()=>{
  for(const ssr of [true,false]){
    const load=['/src/main.ts',{ssr}],transform=['export const answer=42','/src/main.ts',{ssr,moduleType:'js'}]
    const before=structuredClone({load,transform})
    validateCallableHookArguments('load',load);validateCallableHookArguments('transform',transform)
    expect({load,transform}).toEqual(before)
  }
  expect(()=>validateCallableHookArguments('load',['/src/main.ts'])).not.toThrow()
  for(const args of [['/src/main.ts',{ssr:'true'}],['/src/main.ts',{other:true}],['/src/main.ts',{},1]])expect(()=>validateCallableHookArguments('load',args)).toThrow('Invalid load arguments')
})
test('callable descriptors preserve regex and whitelisted callback tags',()=>{
  const calls:unknown[]=[]
  const descriptor=restoreCallableDescriptor({__name:'builtin:vite-resolve',options:{external:[{type:'RegExp',source:'^pkg',flags:'i'}],resolveSubpathImports:{type:'callback'},onDebug:{type:'callback'}}},(method,args)=>{calls.push({method,args});return './answer.js'})
  expect(descriptor.options.external[0].test('PKG')).toBe(true)
  expect(descriptor.options.resolveSubpathImports('#local','/project/a.js')).toBe('./answer.js')
  expect(calls).toEqual([{method:'resolveSubpathImports',args:['#local','/project/a.js']}])
})
test('callable descriptors reject other builtins, functions, and ambiguous tags',()=>{
  for(const value of [null,{__name:'other',options:{}},{__name:'builtin:vite-resolve',options:{unknown:{type:'callback'}}},{__name:'builtin:vite-resolve',options:{onWarn:{type:'callback',extra:true}}},{__name:'builtin:vite-resolve',options:{onWarn:()=>{}}},{__name:'builtin:vite-resolve',options:{external:{type:'RegExp',source:'a',flags:'',extra:1}}}])expect(()=>restoreCallableDescriptor(value,()=>undefined)).toThrow()
})
test('workspace allowance is explicit and bounded independently of WASM memory',()=>{
  expect(callableWorkspaceLimits(1024,16)).toEqual({maxBytes:1024,maxFiles:16})
  expect(callableWorkspaceLimits(256*1024*1024,32768)).toEqual({maxBytes:256*1024*1024,maxFiles:32768})
  for(const pair of [[0,1],[1,0],[256*1024*1024+1,1],[1,32769]])expect(()=>callableWorkspaceLimits(pair[0],pair[1])).toThrow()
})
test('client builtins accept only their installed option shapes',()=>{
  for(const descriptor of [{__name:'builtin:oxc-runtime'},{__name:'builtin:vite-json',options:{stringify:'auto',namedExports:true,minify:false}}])expect(restoreCallableDescriptor(descriptor,()=>undefined)).toEqual({...descriptor,options:descriptor.options})
  for(const descriptor of [{__name:'builtin:oxc-runtime',options:{}},{__name:'builtin:vite-json',options:{onWarn:{type:'callback'}}},{__name:'builtin:vite-json',options:{stringify:'other'}}])expect(()=>restoreCallableDescriptor(descriptor,()=>undefined)).toThrow()
})
