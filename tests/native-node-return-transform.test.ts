import {expect,test} from 'vitest'
import {transformNodeReturns} from '../src/native/node-return-transform'
import {runInNewContext} from 'node:vm'

test.each(['(function own( x ) { /* keep */ return x + 1 })',
  '(function own(){return {value:42}})','(x => x + 1)','(() => ({value:42}))',
  '(async () => 42)','(async function* own(){yield 1;return 2})',
])('non-call returns preserve exact function source %s',source=>{
  const compiled=transformNodeReturns(source,'/app/source.js')
  expect(compiled.code).toBe(source)
  expect(runInNewContext(compiled.code).toString()).toBe(runInNewContext(source).toString())
})

test.each(['(function(){return true?Math.max(1,2):3})()',
  '(function(){return true&&Math.max(1,2)})()',
  '(function(){return (0,Math.max(1,2))})()',
  '(()=>Math.max?.(1,2))()',
])('tail-position calls remain protected for %s',source=>{
  const compiled=transformNodeReturns(source,'/app/tail.js')
  expect(compiled.code).toContain('finally{}')
  expect(runInNewContext(compiled.code)).toBe(runInNewContext(source))
})

test.each(['(()=>({value:42}))()','(()=> (1,2))()','(()=>()=>42)()()',
  '(function(){return ()=>42})()()','(()=>((({value:42}))))()'])('local return edits preserve nested expression %s',source=>{
  expect(runInNewContext(transformNodeReturns(source,'/app/nested.js').code)).toEqual(runInNewContext(source))
})

test('return lowering does not introduce bindings visible to direct eval',()=>{
  for(const source of [
    '(function(){return eval("typeof _returnValue")})()',
    '(function(){return eval("var owned=42;owned")})()',
    '(function(){try{return eval("typeof _returnValue")}finally{}})()',
  ]){
    const transformed=transformNodeReturns(source,'/app/direct-eval.js')
    expect(runInNewContext(transformed.code!)).toBe(runInNewContext(source))
  }
})

test('return lowering preserves values, receivers, async results and finally behavior',async()=>{
  const source='(()=>{const log=[];const object={value:42,read(){return this.value}};function call(){try{return object.read()}finally{log.push("finally")}};return {value:call(),log,asyncValue:async()=>await Promise.resolve(7)}})()'
  const transformed=transformNodeReturns(source,'/app/returns.js')
  const result=(0,eval)(transformed.code)
  expect(result.value).toBe(42)
  expect(result.log).toEqual(['finally'])
  expect(await result.asyncValue()).toBe(7)
  expect(transformed.map?.sourcesContent).toEqual([source])
})
test('async generators keep their iterator contract rather than using the async wrapper',async()=>{
  const source='(async function* values(){yield 1;return 2})'
  const transformed=transformNodeReturns(source,'/app/generator.js',true)
  expect(transformed.asyncModule).toBe(false)
  const values=(0,eval)(transformed.code)
  const iterator=values()
  expect(typeof iterator.next).toBe('function')
  expect(await iterator.next()).toEqual({value:1,done:false})
  expect(await iterator.next()).toEqual({value:2,done:true})
})
test('only a single async function expression can compile as a module',()=>{
  const module=transformNodeReturns('"use strict";async (value)=>value+1','/app/async.js',true)
  expect(module.asyncModule).toBe(true)
  expect(module.code).toContain('export default')
  for(const source of ['(()=>42)','const value=1;async ()=>value','async ()=>42;globalThis.owned=true'])
    expect(transformNodeReturns(source,'/app/sync.js',true).asyncModule).toBe(false)
})
