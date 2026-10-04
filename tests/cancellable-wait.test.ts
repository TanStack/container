import {expect,test,vi} from 'vitest'
import {cancellableWait} from '../src/npm/cancellable-wait'
test('cancels one wait while another caller receives the shared result',async()=>{
  let finish!:(value:number)=>void
  const operation=new Promise<number>(resolve=>{finish=resolve})
  const controller=new AbortController(),reason=Error('cancel wait')
  const remove=vi.spyOn(controller.signal,'removeEventListener')
  const first=cancellableWait(operation,controller.signal)
  const second=cancellableWait(operation)
  const rejected=expect(first).rejects.toBe(reason)
  controller.abort(reason)
  await rejected
  expect(remove).toHaveBeenCalled()
  finish(42)
  await expect(second).resolves.toBe(42)
})
test('preserves rejection identity and rejects an already cancelled wait',async()=>{
  const reason=Error('original')
  await expect(cancellableWait(Promise.reject(reason),new AbortController().signal)).rejects.toBe(reason)
  await expect(cancellableWait(Promise.resolve(1),AbortSignal.abort(reason))).rejects.toBe(reason)
})
