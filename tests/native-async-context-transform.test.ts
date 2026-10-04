import {expect,test} from 'vitest'
import {transformNativeAsyncContext} from '../src/native/async-context-transform'

test('keeps async iterators native while lowering ordinary async functions',async()=>{
  const source=`
    export async function* values() {
      await Promise.resolve()
      yield 1
    }
    export async function collect() {
      const result = []
      for await (const value of values()) result.push(value)
      return result
    }
    export async function ordinary() {
      await Promise.resolve()
      return 2
    }
  `
  const result=await transformNativeAsyncContext(source,'/app/iterator.js')
  expect(result?.code).toMatch(/async function\*\s*values\(\)/)
  expect(result?.code).toMatch(/async function collect\(\)/)
  expect(result?.code).toMatch(/for await\s*\(const value of values\(\)\)/)
  expect(result?.code).toContain('_asyncToGenerator')
  const module=await import(`data:text/javascript,${encodeURIComponent(result!.code)}`)
  expect(await module.collect()).toEqual([1])
  expect(await module.ordinary()).toBe(2)
})

test('preserves async evaluators that compile code with top-level await',async()=>{
  const source=`
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
    export async function evaluate(code) {
      return await new AsyncFunction(code)()
    }
  `
  const result=await transformNativeAsyncContext(source,'/app/evaluator.js')
  expect(result?.code).toContain('async function evaluate(code)')
  const module=await import(`data:text/javascript,${encodeURIComponent(result!.code)}`)
  expect(await module.evaluate('return await Promise.resolve(42)')).toBe(42)
})

test('preserves an async function used to obtain its constructor',async()=>{
  const source=`
    const AsyncFunction = (async function(){}).constructor
    export async function evaluate(code) {
      return await new AsyncFunction(code)()
    }
  `
  const result=await transformNativeAsyncContext(source,'/app/evaluator.js')
  const module=await import(`data:text/javascript,${encodeURIComponent(result!.code)}`)
  expect(await module.evaluate('return await Promise.resolve(42)')).toBe(42)
})
