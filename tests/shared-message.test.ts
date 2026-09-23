import {expect,it,vi} from 'vitest'
import type {QuickJSContext,QuickJSHandle} from 'quickjs-emscripten-core'
import {SharedMessage,SharedMessageSender,sharedDelivery,type SharedBufferLease,type SharedContext} from '../src/sandbox/shared-message'

const target={} as QuickJSContext,value={} as QuickJSHandle
function lease(){
  let alive=true
  const result={value,dispose:vi.fn()} as unknown as ReturnType<QuickJSContext['evalCode']>
  const owned:SharedBufferLease={
    get alive(){return alive},
    adopt:vi.fn(()=>{if(!alive)throw Error('Already consumed');alive=false;return result}),
    dispose:vi.fn(()=>{alive=false}),
  }
  return {owned,result,context:{retainSharedBuffer:vi.fn(()=>owned)} as unknown as SharedContext}
}

for(const accepted of [true,false])it(`successful send transfers ownership when backpressure result is ${accepted}`,()=>{
  const sender=new SharedMessageSender(),fake=lease(),id=sender.retain(fake.context,value)
  let message!:SharedMessage
  expect(sender.send([id],entry=>{message=entry;return accepted})).toBe(accepted)
  sender.dispose();expect(fake.owned.dispose).not.toHaveBeenCalled()
  expect(message.adopt(id,target)).toBe(fake.result)
  expect(fake.owned.adopt).toHaveBeenCalledWith(target)
  expect(()=>message.adopt(id,target)).toThrow('unavailable')
  message.dispose();expect(fake.owned.dispose).not.toHaveBeenCalled()
})

it('a rejected send leaves all ownership provisional for caller rollback',()=>{
  const sender=new SharedMessageSender(),fake=lease(),id=sender.retain(fake.context,value)
  expect(()=>sender.send([id],()=>{throw Error('Queue full')})).toThrow('Queue full')
  expect(fake.owned.dispose).not.toHaveBeenCalled()
  sender.release([id]);expect(fake.owned.dispose).toHaveBeenCalledTimes(1)
  sender.dispose();expect(fake.owned.dispose).toHaveBeenCalledTimes(1)
})

it('undelivered startup envelopes release once independently of their sender',()=>{
  const sender=new SharedMessageSender(),fake=lease(),id=sender.retain(fake.context,value)
  const startup=sender.send([id],message=>message)
  sender.dispose();expect(fake.owned.alive).toBe(true)
  startup.dispose();startup.dispose()
  expect(fake.owned.dispose).toHaveBeenCalledTimes(1)
  expect(()=>startup.adopt(id,target)).toThrow('unavailable')
})

it('failed adoption keeps the lease for envelope cleanup or retry',()=>{
  const fake=lease(),error={error:value,dispose:vi.fn()} as unknown as ReturnType<QuickJSContext['evalCode']>
  vi.mocked(fake.owned.adopt).mockReturnValueOnce(error)
  const message=new SharedMessage(new Map([[1,fake.owned]]))
  expect(message.adopt(1,target)).toBe(error)
  expect(fake.owned.alive).toBe(true)
  expect(message.adopt(1,target)).toBe(fake.result)
  message.dispose();expect(fake.owned.dispose).not.toHaveBeenCalled()
})

it('delivery lookup requires the actual envelope and cannot borrow an unrelated resource',()=>{
  const fake=lease(),message=new SharedMessage(new Map([[1,fake.owned]])),other={dispose:vi.fn()}
  expect(sharedDelivery([other,message])).toBe(message)
  expect(()=>sharedDelivery([other])).toThrow('no shared buffers')
  expect(()=>new SharedMessage(new Map()).adopt(1,target)).toThrow('unavailable')
  expect(fake.owned.adopt).not.toHaveBeenCalled()
  message.dispose()
})

it('invalid reference batches do not partially release valid provisional leases',()=>{
  const sender=new SharedMessageSender(),fake=lease(),id=sender.retain(fake.context,value)
  expect(()=>sender.release([id,id+1])).toThrow('unavailable')
  expect(()=>sender.send([id,id],()=>true)).toThrow('Invalid')
  expect(fake.owned.dispose).not.toHaveBeenCalled()
  sender.dispose();expect(fake.owned.dispose).toHaveBeenCalledTimes(1)
})

it('envelope cleanup releases remaining references even if one disposer fails',()=>{
  const first=lease(),second=lease()
  vi.mocked(first.owned.dispose).mockImplementation(()=>{throw Error('cleanup failed')})
  const message=new SharedMessage(new Map([[1,first.owned],[2,second.owned]]))
  expect(()=>message.dispose()).toThrow('cleanup failed')
  expect(second.owned.dispose).toHaveBeenCalledTimes(1)
  message.dispose()
  expect(first.owned.dispose).toHaveBeenCalledTimes(1)
  expect(second.owned.dispose).toHaveBeenCalledTimes(1)
})

it('memory and buffer leases share delivery ownership but use distinct native retain operations',()=>{
  const sender=new SharedMessageSender(),buffer=lease(),memory=lease()
  const context={retainSharedBuffer:vi.fn(()=>buffer.owned),retainSharedWasmMemory:vi.fn(()=>memory.owned)} as unknown as SharedContext
  const bufferId=sender.retain(context,value),memoryId=sender.retainMemory(context,value)
  expect(memoryId).not.toBe(bufferId)
  expect(context.retainSharedWasmMemory).toHaveBeenCalledWith(value)
  const message=sender.send([bufferId,memoryId],entry=>entry)
  sender.dispose()
  expect(message.adopt(memoryId,target)).toBe(memory.result)
  message.dispose()
  expect(memory.owned.dispose).not.toHaveBeenCalled()
  expect(buffer.owned.dispose).toHaveBeenCalledTimes(1)
})

it('memory retention failures leave sender ownership unchanged and rejected sends can roll back',()=>{
  const sender=new SharedMessageSender(),memory=lease()
  const retainSharedWasmMemory=vi.fn(()=>memory.owned).mockImplementationOnce(()=>{throw Error('Memory is not shared')})
  const context={retainSharedWasmMemory} as unknown as SharedContext
  expect(()=>sender.retainMemory(context,value)).toThrow('not shared')
  const id=sender.retainMemory(context,value)
  expect(()=>sender.send([id],()=>{throw Error('Queue full')})).toThrow('Queue full')
  sender.release([id]);sender.dispose()
  expect(memory.owned.dispose).toHaveBeenCalledTimes(1)
})
