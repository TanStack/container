import {expect,it} from 'vitest'
import {promisify} from '../src/vite-browser/node-util'
it('uses the Node registry symbol and honors custom promise results',async()=>{
  expect(promisify.custom).toBe(Symbol.for('nodejs.util.promisify.custom'))
  const original=()=>{},custom=async()=>({stdout:'answer',stderr:''})
  Object.defineProperty(original,promisify.custom,{value:custom})
  expect(promisify(original)).toBe(custom)
  expect(promisify(custom)).toBe(custom)
  await expect(promisify(original)()).resolves.toEqual({stdout:'answer',stderr:''})
})
it('keeps generic callback conversion and idempotency',async()=>{
  const wrapped=promisify((value:number,done:Function)=>done(null,value+1))
  expect(promisify(wrapped)).toBe(wrapped)
  await expect(wrapped(41)).resolves.toBe(42)
  const failed=promisify((done:Function)=>done(Error('failure')))
  await expect(failed()).rejects.toThrow('failure')
})
