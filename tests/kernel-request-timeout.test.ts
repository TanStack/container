import {describe,expect,it} from 'vitest'
import {kernelRequestDeadlines} from '../src/sandbox/kernel-request-timeout'

describe('kernel request deadlines',()=>{
  it('gives bounded package installation more time than ordinary RPC',()=>{
    expect(kernelRequestDeadlines('readFile',120_000)).toEqual({idleMs:120_000})
    expect(kernelRequestDeadlines('install',120_000)).toEqual({idleMs:150_000,absoluteMs:300_000,progressRenewable:true})
  })

  it('keeps execution tied to the configured guest budget',()=>{
    expect(kernelRequestDeadlines('execute',42_000)).toEqual({idleMs:72_000})
    expect(kernelRequestDeadlines('processWait',42_000)).toEqual({idleMs:72_000})
  })
})
