import {test,expect,vi} from 'vitest'
import {abortableWait} from '../src/sandbox/abortable-wait'

test('cancels one waiter without cancelling the shared operation',async()=>{
  let finish!:(value:number)=>void
  const pending=new Promise<number>(resolve=>{finish=resolve})
  const first=new AbortController(),second=new AbortController()
  const cancelled=abortableWait(pending,first.signal)
  const surviving=abortableWait(pending,second.signal)
  const assertion=expect(cancelled).rejects.toBe('stopped')
  first.abort('stopped');await assertion
  finish(42);expect(await surviving).toBe(42)
})

test('removes abort listeners on resolution and rejection',async()=>{
  for(const failure of [false,true]){
    const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener')
    const pending=abortableWait(failure?Promise.reject('failed'):Promise.resolve(42),controller.signal)
    if(failure)await expect(pending).rejects.toBe('failed')
    else expect(await pending).toBe(42)
    expect(remove).toHaveBeenCalledOnce()
  }
})

test('rejects already cancelled consumers',async()=>{
  const controller=new AbortController();controller.abort('stopped')
  await expect(abortableWait(Promise.resolve(42),controller.signal)).rejects.toBe('stopped')
  await expect(abortableWait(Promise.reject('late failure'),controller.signal)).rejects.toBe('stopped')
})
