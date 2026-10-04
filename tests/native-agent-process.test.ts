import {expect,it,vi} from 'vitest'
import {spawnNativeAgentProcess} from '../src/native/agent-process'

it('forwards explicit binary stdin and EOF, rejects input after EOF and exit',async()=>{
  let finish!:(value:any)=>void
  const writeInput=vi.fn(),endInput=vi.fn(),interrupt=vi.fn()
  const backend={terminalCommand:vi.fn(),openTerminalCommand:vi.fn(()=>({
    result:new Promise<any>(resolve=>{finish=resolve}),writeInput,endInput,interrupt,resize:vi.fn(),
  }))}
  const process=spawnNativeAgentProcess(backend,{command:'node',cwd:'/app'},{stdin:'pipe'})
  const bytes=new Uint8Array([0,128,255])
  await process.writeInput!(bytes)
  expect(writeInput).toHaveBeenCalledWith(bytes)
  await process.endInput!();await process.endInput!()
  expect(endInput).toHaveBeenCalledOnce()
  await expect(process.writeInput!('late')).rejects.toThrow('closed')
  finish({exitCode:0,cwd:'/app',changedPaths:[]})
  await process.wait()
  await expect(process.endInput!()).rejects.toThrow('closed')
  expect(backend.terminalCommand).not.toHaveBeenCalled()
  await process.dispose()
})

it('interrupts piped commands and waits for acknowledgement on disposal',async()=>{
  let finish!:(value:any)=>void
  const interrupt=vi.fn()
  const process=spawnNativeAgentProcess({terminalCommand:vi.fn(),openTerminalCommand:()=>({
    result:new Promise<any>(resolve=>{finish=resolve}),writeInput:vi.fn(),endInput:vi.fn(),interrupt,resize:vi.fn(),
  })},{command:'node',cwd:'/app'},{stdin:'pipe'})
  const done=vi.fn(),closing=process.dispose().then(done)
  expect(interrupt).toHaveBeenCalledOnce()
  await expect(process.writeInput!('late')).rejects.toThrow('closed')
  expect(done).not.toHaveBeenCalled()
  finish({exitCode:0,cwd:'/app',changedPaths:[]})
  await closing
  await expect(process.wait()).rejects.toMatchObject({name:'AbortError'})
})

it('does not swallow transport failure during disposal',async()=>{
  let reject!: (error:unknown)=>void
  const terminalCommand=vi.fn(()=>new Promise<any>((_resolve,rejectOperation)=>{reject=rejectOperation}))
  const process=spawnNativeAgentProcess({terminalCommand},{command:'node',cwd:'/app'})
  const closing=process.dispose(),reason=Error('owner disconnected')
  reject(reason)
  await expect(closing).rejects.toBe(reason)
  await expect(process.wait()).rejects.toBe(reason)
})
it('rejects concurrent readers without replacing the original pending read',async()=>{
  let finish!:()=>void
  const terminalCommand=vi.fn((_line:string,cwd:string)=>new Promise<any>(resolve=>{finish=()=>resolve({exitCode:0,cwd,changedPaths:[],stdout:'',stderr:''})}))
  const process=spawnNativeAgentProcess({terminalCommand},{command:'node',cwd:'/app'})
  const first=process.next()
  await expect(process.next()).rejects.toThrow('Concurrent')
  finish()
  expect(await first).toEqual({type:'exit',code:0,signal:null})
  await process.dispose()
})

it('streams output then real completion without VM metrics',async()=>{
  const terminalCommand=vi.fn(async(_line:string,cwd:string,output:any)=>{
    output('hello','stdout');output('err','stderr')
    return {exitCode:7,cwd,changedPaths:[],stdout:'',stderr:''}
  })
  const process=spawnNativeAgentProcess({terminalCommand},{command:'node',cwd:'/app'})
  expect(await process.next()).toEqual({type:'stdout',bytes:new TextEncoder().encode('hello')})
  expect(await process.next()).toEqual({type:'stderr',bytes:new TextEncoder().encode('err')})
  expect(await process.next()).toEqual({type:'exit',code:7,signal:null})
  expect(await process.next()).toBeNull()
  expect(await process.wait()).toEqual({exitCode:7,signal:null})
  await process.dispose()
})
it('bounds unread output and preserves its failure',async()=>{
  const terminalCommand=vi.fn(async(_line:string,cwd:string,output:any)=>{
    output('too much','stdout');return {exitCode:0,cwd,changedPaths:[],stdout:'',stderr:''}
  })
  const process=spawnNativeAgentProcess({terminalCommand},{command:'node',cwd:'/app'},{maxQueuedBytes:1})
  await expect(process.next()).rejects.toMatchObject({code:'ERR_OUTPUT_LIMIT'})
  await expect(process.wait()).rejects.toMatchObject({code:'ERR_OUTPUT_LIMIT'})
  await process.dispose()
})
it('waits for cancellation acknowledgement and closes a waiting reader',async()=>{
  let finish!:()=>void
  const terminalCommand=vi.fn((_line:string,cwd:string,_output:any,signal?:AbortSignal)=>new Promise<any>(resolve=>{
    finish=()=>resolve({exitCode:0,cwd,changedPaths:[],stdout:'',stderr:''})
    expect(signal).toBeInstanceOf(AbortSignal)
  }))
  const process=spawnNativeAgentProcess({terminalCommand},{command:'node',cwd:'/app'})
  const read=process.next(),closed=vi.fn(),closing=process.dispose().then(closed)
  expect(await read).toBeNull();expect(closed).not.toHaveBeenCalled()
  finish();await closing
  expect(closed).toHaveBeenCalledOnce()
  await expect(process.wait()).rejects.toMatchObject({name:'AbortError'})
  await expect(process.kill('SIGTERM')).rejects.toMatchObject({code:'ERR_UNSUPPORTED_OPERATION'})
})
