import {test,expect} from 'vitest'
import {GuestProcesses,InputPipe,processStdio,type ProcessInput} from '../src/sandbox/guest-processes'
const input:ProcessInput={code:'',argv:[],options:{}}
const result={exitCode:0,stdout:'',stderr:'',duration:0,wasmHeapBytes:0}

test('stdio normalization only permits owned standard endpoints',()=>{
  expect(processStdio(undefined)).toEqual(['pipe','pipe','pipe'])
  expect(processStdio('inherit')).toEqual(['inherit','inherit','inherit'])
  expect(processStdio(['ignore',null,2])).toEqual(['ignore','pipe','inherit'])
  for(const value of ['ipc',[3],[{},'pipe'],['pipe','pipe','pipe','ipc'],[1,2,0]])expect(()=>processStdio(value)).toThrow('Unsupported')
})

test('inherited input readers compete for bytes and cancelling one preserves the others',async()=>{
  const pipe=new InputPipe(),a=pipe.read(1),b=pipe.read(2)
  expect(()=>pipe.read(1)).toThrow('already pending')
  pipe.cancelRead(1);expect(await a).toBe(null)
  await pipe.write(new Uint8Array([7]));expect(await b).toEqual(new Uint8Array([7]))
  const c=pipe.read(3),d=pipe.read(4)
  await pipe.write(new Uint8Array([8]));expect(await c).toEqual(new Uint8Array([8]))
  pipe.end();expect(await d).toBe(null)
})

test('inherited output reaches the parent, ignored output does not enter either queue',async()=>{
  let finish!:()=>void
  const processes=new GuestProcesses(async record=>{
    if(record.owner===0)await new Promise<void>(resolve=>finish=resolve)
    else{
      processes.emit(record,{type:'stdout',bytes:new Uint8Array([1])})
      processes.emit(record,{type:'stderr',bytes:new Uint8Array([2])})
    }
    return result
  })
  const parent=processes.start(0,input)
  const child=processes.start(parent.pid,{...input,options:{stdio:['ignore','ignore','inherit']}})
  await child.result
  expect(await processes.next(0,parent.pid)).toEqual({type:'stderr',bytes:new Uint8Array([2])})
  expect(await processes.next(parent.pid,child.pid)).toEqual({type:'exit',code:0,signal:null})
  expect(parent.queuedBytes).toBe(0)
  finish();await parent.result
})

test('a child cannot write to or close the inherited parent input through its pipe API',async()=>{
  let finish!:()=>void
  const processes=new GuestProcesses(async record=>{
    if(record.owner===0)await new Promise<void>(resolve=>finish=resolve)
    return result
  })
  const parent=processes.start(0,input)
  const child=processes.start(parent.pid,{...input,options:{stdio:['inherit','pipe','pipe']}})
  expect(child.stdin).toBe(parent.stdin)
  expect(()=>processes.writeInput(parent.pid,child.pid,new Uint8Array([1]))).toThrow('not a pipe')
  expect(()=>processes.endInput(parent.pid,child.pid)).toThrow('not a pipe')
  expect(()=>processes.writeInput(999,parent.pid,new Uint8Array([1]))).toThrow('unavailable')
  await child.result
  await processes.writeInput(0,parent.pid,new Uint8Array([9]))
  expect(await parent.stdin.read(parent.pid)).toEqual(new Uint8Array([9]))
  finish();await parent.result
})

test('inherited output keeps parent queue bounds and a live parent is required',async()=>{
  let finish!:()=>void
  const processes=new GuestProcesses(async record=>{
    if(record.owner===0)await new Promise<void>(resolve=>finish=resolve)
    return result
  })
  expect(()=>processes.start(0,{...input,options:{stdio:'inherit'}})).toThrow('unavailable parent')
  const parent=processes.start(0,input),child=processes.start(parent.pid,{...input,options:{stdio:['pipe','inherit','inherit']}})
  processes.emit(child,{type:'stdout',bytes:new Uint8Array(1024*1024)})
  expect(()=>processes.emit(child,{type:'stderr',bytes:new Uint8Array([1])})).toThrow('output queue')
  await child.result;finish();await parent.result
})

test('ignored stdin ends immediately and inherited output reaches non-capturing owners',async()=>{
  let finish!:()=>void
  const processes=new GuestProcesses(async record=>{
    if(record.owner===0)await new Promise<void>(resolve=>finish=resolve)
    return result
  })
  const parent=processes.start(0,input,undefined,false),seen:unknown[]=[]
  parent.receiveOutput=event=>seen.push(event)
  const child=processes.start(parent.pid,{...input,options:{stdio:['ignore','inherit','inherit']}})
  expect(await child.stdin.read(child.pid)).toBe(null)
  processes.emit(child,{type:'stdout',bytes:new Uint8Array([8])})
  expect(seen).toEqual([{type:'stdout',bytes:new Uint8Array([8])}])
  await child.result;finish();await parent.result
})

test('streamed inherited output preserves parent backpressure',async()=>{
  const processes=new GuestProcesses(record=>new Promise(resolve=>record.controller.signal.addEventListener('abort',()=>resolve(result))))
  const parent=processes.start(0,input),child=processes.start(parent.pid,{...input,options:{stdio:['ignore','inherit','inherit']}})
  for(let i=0;i<16;i++)await processes.writeOutput(child,{type:'stdout',bytes:new Uint8Array(65536)})
  let completed=false
  const writing=processes.writeOutput(child,{type:'stdout',bytes:new Uint8Array([42])}).then(()=>completed=true)
  await Promise.resolve();expect(completed).toBe(false)
  await processes.next(0,parent.pid);await writing;expect(completed).toBe(true)
  processes.kill(parent.pid,child.pid);await child.result
  processes.kill(0,parent.pid);await parent.result
})
