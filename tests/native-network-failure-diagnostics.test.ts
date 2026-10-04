import {expect,it,vi} from 'vitest'
import {reportNativeNetworkFailure} from '../src/native/network-failure-diagnostics'

it('captures reset socket state and rethrows the same error',()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{})
  const error=Object.assign(Error('reset'),{code:'ECONNRESET'})
  const snapshot=vi.fn(()=>[{kind:'socket',port:3000,events:['error']}])
  try{
    let caught
    try{reportNativeNetworkFailure(error,snapshot)}catch(value){caught=value}
    expect(caught).toBe(error)
    expect(snapshot).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledExactlyOnceWith('NATIVE_NETWORK_FAILURE',JSON.stringify({error:'Error: reset',handles:[{kind:'socket',port:3000,events:['error']}]}))
  }finally{log.mockRestore()}
})

it('leaves other errors untouched without taking a snapshot',()=>{
  const error=Error('other'),snapshot=vi.fn()
  let caught
  try{reportNativeNetworkFailure(error,snapshot)}catch(value){caught=value}
  expect(caught).toBe(error)
  expect(snapshot).not.toHaveBeenCalled()
})

it('does not replace the original reset when diagnostics fail',()=>{
  const error=Object.assign(Error('reset'),{code:'ECONNRESET'})
  let caught
  try{reportNativeNetworkFailure(error,()=>{throw Error('snapshot failed')})}catch(value){caught=value}
  expect(caught).toBe(error)
})
