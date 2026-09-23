import {test,expect} from 'vitest'
import {compilerPolicy} from '../src/compiler/compiler-policy'

test('compiler policy is disabled by default and copies explicit owner settings',()=>{
  expect(compilerPolicy(undefined)).toBeUndefined()
  const input={maxMemoryPages:1024,timeoutMs:15000}
  const result=compilerPolicy(input)
  input.timeoutMs=1
  expect(result).toEqual({maxMemoryPages:1024,timeoutMs:15000,lifetime:'bounded'})
  expect(Object.isFrozen(result)).toBe(true)
})
test('session accounting requires an explicit owner policy',()=>{
  expect(compilerPolicy({maxMemoryPages:1024,timeoutMs:1000,lifetime:'session'})?.lifetime).toBe('session')
  expect(()=>compilerPolicy({maxMemoryPages:1024,timeoutMs:1000,lifetime:'forever'})).toThrow('Invalid experimental compiler lifetime')
})
test('compiler policy rejects invalid budgets without raising them',()=>{
  for(const value of [null,true,[],{},
    {maxMemoryPages:94,timeoutMs:100},
    {maxMemoryPages:8193,timeoutMs:100},
    {maxMemoryPages:1024.5,timeoutMs:100},
    {maxMemoryPages:1024,timeoutMs:9},
    {maxMemoryPages:1024,timeoutMs:120001},
  ])expect(()=>compilerPolicy(value)).toThrow('Invalid experimental compiler policy')
})
