import {test,expect,vi} from 'vitest'
import {Volume} from 'memfs'
import {NativeTerminalSession} from '../src/native/terminal-session'

function setup(){
  const sent:any[]=[]
  const worker={postMessage:(message:any)=>sent.push(message),terminate:vi.fn(),onmessage:null as any}
  const session=new NativeTerminalSession(Volume.fromJSON({'/app/main.js':''}),'/tmp','https://sandbox.test/',()=>worker as any)
  worker.onmessage({data:{ready:true}})
  return {worker,session,sent}
}
test('persistent session retains scratch cwd in its next worker command',async()=>{
  const {worker,session,sent}=setup()
  try{
    const first=session.run('cd /tmp/task');await Promise.resolve()
    expect(sent.at(-1).cwd).toBe('/tmp')
    worker.onmessage({data:{result:{code:0,cwd:'/tmp/task'}}})
    expect((await first).cwd).toBe('/tmp/task')
    const second=session.run('pwd');await Promise.resolve()
    expect(sent.at(-1).cwd).toBe('/tmp/task')
    worker.onmessage({data:{result:{code:0}}})
    expect((await second).cwd).toBe('/tmp/task')
  }finally{session.dispose()}
})
test('invalid returned cwd rejects and closes the session',async()=>{
  const {worker,session}=setup()
  const command=session.run('pwd');await Promise.resolve()
  const rejected=expect(command).rejects.toThrow('outside the container')
  worker.onmessage({data:{result:{code:0,cwd:'/etc'}}})
  await rejected
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(session.run('pwd')).rejects.toThrow('closed')
})
test('invalid command releases its transferred input port without closing the session',async()=>{
  const {worker,session}=setup()
  const port={close:vi.fn()} as unknown as MessagePort
  try{
    await expect(session.run('x'.repeat(8193),undefined,undefined,port)).rejects.toThrow('exceeds limit')
    expect(port.close).toHaveBeenCalledOnce()
    const next=session.run('pwd');await Promise.resolve()
    worker.onmessage({data:{result:{code:0}}})
    expect((await next).exitCode).toBe(0)
  }finally{session.dispose()}
})
test('failed command transport releases input and rejects future commands',async()=>{
  const {worker,session}=setup()
  const port={close:vi.fn(),start:vi.fn(),onmessage:null,onmessageerror:null} as unknown as MessagePort
  worker.postMessage=()=>{throw Error('Transport failed')}
  await expect(session.run('pwd',undefined,undefined,port)).rejects.toThrow('Transport failed')
  expect(port.close).toHaveBeenCalledOnce()
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(session.run('pwd')).rejects.toThrow('closed')
  session.dispose()
  expect(worker.terminate).toHaveBeenCalledOnce()
})
test('failed interrupt transport rejects the command and releases the session',async()=>{
  const {worker,session}=setup()
  const controller=new AbortController()
  const command=session.run('cat',undefined,controller.signal)
  const rejected=expect(command).rejects.toThrow('Interrupt transport failed')
  await Promise.resolve()
  worker.postMessage=()=>{throw Error('Interrupt transport failed')}
  controller.abort()
  await rejected
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(session.run('pwd')).rejects.toThrow('closed')
})
test('disposing an input-waiting command removes its abort listener and closes input once',async()=>{
  const {worker,session,sent}=setup()
  const controller=new AbortController()
  const remove=vi.spyOn(controller.signal,'removeEventListener')
  const port={close:vi.fn(),start:vi.fn(),onmessage:null,onmessageerror:null} as unknown as MessagePort
  const command=session.run('cat',undefined,controller.signal,port)
  const rejected=expect(command).rejects.toThrow('Terminal session closed')
  await Promise.resolve()
  worker.onmessage({data:{id:1,method:'stdio.read',args:[]}})
  session.dispose()
  await rejected
  await Promise.resolve()
  expect(port.close).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledWith('abort',expect.any(Function))
  expect(sent.some(message=>message.reply===1)).toBe(false)
  const count=sent.length
  controller.abort()
  expect(sent).toHaveLength(count)
  session.dispose()
  expect(worker.terminate).toHaveBeenCalledOnce()
})
