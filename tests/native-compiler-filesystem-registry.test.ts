import {expect,test} from 'vitest'
import {getCompilerFilesystem,registerCompilerFilesystem} from '../src/native/compiler-filesystem-registry'

test('compiler bundles share the same filesystem without copying it',()=>{
  const scope={},provider={fs:{},vol:{}}
  const installed=registerCompilerFilesystem(provider,scope)
  expect(getCompilerFilesystem(scope)).toBe(installed)
  expect(installed.fs).toBe(provider.fs)
  expect(installed.vol).toBe(provider.vol)
  expect(Object.isFrozen(installed)).toBe(true)
  expect(registerCompilerFilesystem({...provider},scope)).toBe(installed)
})

test('a worker cannot replace its compiler filesystem',()=>{
  const scope={},provider={fs:{},vol:{}}
  registerCompilerFilesystem(provider,scope)
  expect(()=>registerCompilerFilesystem({fs:{},vol:provider.vol},scope)).toThrow('different compiler filesystem')
  expect(()=>registerCompilerFilesystem({fs:provider.fs,vol:{}},scope)).toThrow('different compiler filesystem')
  const key=Symbol.for('tanstack-container:compiler-filesystem-v1')
  expect(()=>Object.defineProperty(scope,key,{value:{fs:{},vol:{}}})).toThrow(TypeError)
  expect(getCompilerFilesystem(scope).fs).toBe(provider.fs)
})

test('each worker owns its own filesystem and initialization is required',()=>{
  const first={},second={}
  expect(()=>getCompilerFilesystem(first)).toThrow('has not been registered')
  expect(()=>registerCompilerFilesystem({fs:null,vol:{}} as any,first)).toThrow('requires fs and vol')
  const left=registerCompilerFilesystem({fs:{},vol:{}},first)
  const right=registerCompilerFilesystem({fs:{},vol:{}},second)
  expect(getCompilerFilesystem(first)).toBe(left)
  expect(getCompilerFilesystem(second)).toBe(right)
  expect(left.fs).not.toBe(right.fs)
})
