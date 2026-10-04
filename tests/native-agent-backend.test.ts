import {expect,it,vi} from 'vitest'
import {NativeAgentBackend} from '../src/native/agent-backend'
it('cancels an active install and waits for its acknowledgement before owner disposal',async()=>{
  let finish!:()=>void,signal!:AbortSignal
  const owner={terminalCommand:vi.fn((_line:string,_cwd:string,_output:unknown,received:AbortSignal)=>{
    signal=received
    return new Promise<any>(resolve=>{finish=()=>resolve({exitCode:0,cwd:'/app',stdout:'',stderr:'',changedPaths:[]})})
  }),installResult:vi.fn(),dispose:vi.fn(async()=>{}),close:vi.fn()}
  const backend=new NativeAgentBackend(owner as never)
  const installing=backend.install()
  const rejected=expect(installing).rejects.toMatchObject({name:'AbortError'})
  backend.close();await Promise.resolve();await Promise.resolve()
  expect(signal.aborted).toBe(true);expect(owner.dispose).not.toHaveBeenCalled()
  finish();await rejected;await backend.shutdown
  expect(owner.installResult).not.toHaveBeenCalled();expect(owner.dispose).toHaveBeenCalledOnce()
})
it('does not allow a process to start while workspace replacement is pending',async()=>{
  let finish!:()=>void
  const owner={restoreWorkspace:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve})),terminalCommand:vi.fn()}
  const backend=new NativeAgentBackend(owner as never)
  const restoring=backend.restore({version:5,files:{},directories:[],symlinks:{},fileModes:{},directoryModes:{}})
  await expect(backend.spawn('node')).rejects.toThrow('replacement')
  expect(owner.terminalCommand).not.toHaveBeenCalled()
  finish();await restoring
})
it('waits for a pending file write before disposing the owner',async()=>{
  let finish!:()=>void
  const owner={writeFile:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve})),dispose:vi.fn(async()=>{}),close:vi.fn()}
  const backend=new NativeAgentBackend(owner as never)
  const writing=backend.writeFile('/app/value',new Uint8Array([1]))
  backend.close();await Promise.resolve();await Promise.resolve()
  expect(owner.dispose).not.toHaveBeenCalled()
  finish();await writing;await backend.shutdown
  expect(owner.dispose).toHaveBeenCalledOnce()
})
it('waits for owner shutdown and rejects operations after close',async()=>{
  let finish!:()=>void
  const owner={dispose:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve})),close:vi.fn(),readFile:vi.fn()}
  const backend=new NativeAgentBackend(owner as never)
  backend.close();backend.close()
  await expect(backend.readFile('/app/a')).rejects.toThrow('closed')
  await Promise.resolve()
  expect(owner.close).not.toHaveBeenCalled()
  finish();await backend.shutdown
  expect(owner.dispose).toHaveBeenCalledOnce();expect(owner.close).toHaveBeenCalledOnce()
  expect(owner.readFile).not.toHaveBeenCalled()
})
it('rejects unsupported install and spawn behavior before dispatch',async()=>{
  const owner={terminalCommand:vi.fn()}
  const backend=new NativeAgentBackend(owner as never)
  await expect(backend.install({ignoreScripts:false})).rejects.toMatchObject({code:'ERR_UNSUPPORTED_OPERATION'})
  await expect(backend.install({cwd:'/other'})).rejects.toThrow('workspace root')
  await expect(backend.spawn('node',[],{stdio:'ignore'})).rejects.toMatchObject({code:'ERR_UNSUPPORTED_OPERATION'})
  expect(owner.terminalCommand).not.toHaveBeenCalled()
})
it('closes file capabilities and owner transport even if owner disposal fails',async()=>{
  const failure=Error('dispose failed'),owner={dispose:vi.fn(async()=>{throw failure}),close:vi.fn(),listDirectory:vi.fn()}
  const backend=new NativeAgentBackend(owner as never)
  const files=await backend.openFileSession()
  backend.close()
  await expect(backend.shutdown).rejects.toBe(failure)
  await expect(files.call('readdir',['/app',{recursive:true,withFileTypes:true}])).rejects.toThrow('closed')
  expect(owner.close).toHaveBeenCalledOnce()
})
