import {expect,it} from 'vitest'
import {kernelLimits,executionLimits,childExecutionLimits,workspaceLimits,sharedMemoryPerEngineLimits,workerMemoryLimit,workerExecutionLimits} from '../src/sandbox/kernel-limits'

it('validates an optional host worker ceiling without changing defaults',()=>{
  const owner=kernelLimits({maxBytes:128*1024*1024})
  expect(workerMemoryLimit(owner,undefined)).toBeUndefined()
  for(const value of [256*1024,64*1024*1024,owner.maxBytes])expect(workerMemoryLimit(owner,value)).toBe(value)
  for(const value of [null,false,'65536',NaN,Infinity,-1,0,256*1024-1,256*1024+0.5,owner.maxBytes+1])expect(()=>workerMemoryLimit(owner,value)).toThrow('Invalid worker memory limit')
  expect(workerExecutionLimits(owner)).toEqual(owner)
})
it('clamps worker and nested worker allocations without changing timeout or subprocess inheritance',()=>{
  const parent={maxBytes:128*1024*1024,timeoutMs:15000}
  const worker=workerExecutionLimits(parent,64*1024*1024)
  expect(worker).toEqual({maxBytes:64*1024*1024,timeoutMs:15000})
  expect(workerExecutionLimits(worker,64*1024*1024)).toEqual(worker)
  const reduced={maxBytes:32*1024*1024,timeoutMs:1000}
  expect(workerExecutionLimits(reduced,64*1024*1024)).toEqual(reduced)
  expect(childExecutionLimits(parent)).toEqual(parent)
  expect(parent.maxBytes).toBe(128*1024*1024)
})

it('defaults shared storage per engine separately and freezes the copied policy',()=>{
  expect(sharedMemoryPerEngineLimits()).toEqual({maxBytes:16*1024*1024,growthReservation:false})
  const input={maxBytes:65536},policy=sharedMemoryPerEngineLimits(input,true)
  input.maxBytes=131072
  expect(policy.maxBytes).toBe(65536);expect(Object.isFrozen(policy)).toBe(true)
  expect(sharedMemoryPerEngineLimits({},true)).toEqual({maxBytes:16*1024*1024,growthReservation:false})
  expect(sharedMemoryPerEngineLimits({maxBytes:1536*1024*1024},true).maxBytes).toBe(1536*1024*1024)
})
it('accepts only explicit boolean growth reservation and keeps it immutable',()=>{
  const input={growthReservation:true},policy=sharedMemoryPerEngineLimits(input,true)
  input.growthReservation=false
  expect(policy.growthReservation).toBe(true);expect(Object.isFrozen(policy)).toBe(true)
  for(const growthReservation of [null,0,1,'true',[],{}])expect(()=>sharedMemoryPerEngineLimits({growthReservation:growthReservation as boolean},true)).toThrow('growth reservation')
  expect(()=>sharedMemoryPerEngineLimits({growthReservation:true},false)).toThrow('requires experimental fibers')
})
it('requires the experimental fiber engine for an explicit shared storage policy',()=>{
  for(const experimental of [false,undefined])expect(()=>sharedMemoryPerEngineLimits({},experimental)).toThrow('requires experimental fibers')
})
it('rejects invalid shared storage policy objects and byte limits',()=>{
  for(const value of [null,[],0,'limits',false])expect(()=>sharedMemoryPerEngineLimits(value as any,true)).toThrow('Invalid shared memory')
  for(const maxBytes of [null,NaN,Infinity,-1,0,65535,65536.5,'65536',1536*1024*1024+1,Number.MAX_SAFE_INTEGER+1])expect(()=>sharedMemoryPerEngineLimits({maxBytes:maxBytes as number},true)).toThrow('Invalid shared memory')
})

it('inherits approved child budgets without allowing escalation',()=>{
  const parent={maxBytes:128*1024*1024,timeoutMs:30000}
  expect(childExecutionLimits(parent)).toEqual(parent)
  const reduced=childExecutionLimits(parent,{maxBytes:32*1024*1024,timeoutMs:1000})
  expect(childExecutionLimits(reduced)).toEqual(reduced)
  expect(()=>childExecutionLimits(parent,{maxBytes:parent.maxBytes+1})).toThrow()
  expect(()=>childExecutionLimits(parent,{timeoutMs:parent.timeoutMs+1})).toThrow()
  expect(()=>childExecutionLimits(parent,{maxBytes:NaN})).toThrow()
})

it('keeps workspace quotas separate from guest allocation',()=>{
  expect(workspaceLimits()).toEqual({maxBytes:32*1024*1024,maxFiles:16384})
  expect(workspaceLimits({maxBytes:128*1024*1024}).maxBytes).toBe(128*1024*1024)
  for(const maxBytes of [-1,NaN,Infinity,1.5,512*1024*1024+1])expect(()=>workspaceLimits({maxBytes})).toThrow()
  for(const maxFiles of [0,131073,1.5])expect(()=>workspaceLimits({maxFiles})).toThrow()
})

it('preserves the original ceilings and per-command defaults',()=>{
  const limits=kernelLimits()
  expect(limits).toEqual({maxBytes:64*1024*1024,timeoutMs:30000})
  expect(executionLimits(limits)).toEqual({maxBytes:16*1024*1024,timeoutMs:5000})
  expect(()=>executionLimits(limits,{maxBytes:128*1024*1024})).toThrow('Invalid execution limits')
  expect(()=>executionLimits(limits,{timeoutMs:30001})).toThrow('Invalid execution limits')
})
it('copies host ceilings and does not increase command defaults',()=>{
  const input={maxBytes:256*1024*1024,timeoutMs:120000},limits=kernelLimits(input)
  input.maxBytes=512*1024*1024
  expect(Object.isFrozen(limits)).toBe(true)
  expect(executionLimits(limits)).toEqual({maxBytes:16*1024*1024,timeoutMs:5000})
  expect(executionLimits(limits,{maxBytes:256*1024*1024,timeoutMs:90000})).toEqual({maxBytes:256*1024*1024,timeoutMs:90000})
  expect(()=>executionLimits(limits,{maxBytes:256*1024*1024+1})).toThrow()
  expect(executionLimits(kernelLimits({maxBytes:1024*1024,timeoutMs:100}))).toEqual({maxBytes:1024*1024,timeoutMs:100})
})
it('rejects invalid, fractional, or unsupported resource limits',()=>{
  for(const value of [NaN,Infinity,-1,0,1.5,'64',512*1024*1024+1]){
    expect(()=>kernelLimits({maxBytes:value as number})).toThrow()
    expect(()=>executionLimits(kernelLimits(),{maxBytes:value as number})).toThrow()
  }
  for(const value of [NaN,Infinity,-1,0,10.5,'100',120001])expect(()=>kernelLimits({timeoutMs:value as number})).toThrow()
})
