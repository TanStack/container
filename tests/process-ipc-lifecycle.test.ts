import {test,expect} from 'vitest'
import {GuestProcesses} from '../src/sandbox/guest-processes'
const input={code:'',argv:[],options:{}}
const result={exitCode:0,stdout:'',stderr:'',duration:0,wasmHeapBytes:0}
function setup(){
  const processes=new GuestProcesses(record=>new Promise(resolve=>{
    if(record.controller.signal.aborted)resolve(result)
    else record.controller.signal.addEventListener('abort',()=>resolve(result),{once:true})
  }))
  const parent=processes.start(0,input),child=processes.start(parent.pid,{...input,ipc:true})
  return {processes,parent,child}
}
test('managed IPC isolates endpoints and drains accepted messages on disconnect',async()=>{
  const {processes,parent,child}=setup()
  try{
    const stranger=processes.start(0,input)
    expect(()=>processes.sendIPC(stranger.pid,child.pid,new Uint8Array())).toThrow('unavailable')
    expect(()=>processes.receiveIPC(stranger.pid,child.pid)).toThrow('unavailable')
    expect(()=>processes.disconnectIPC(stranger.pid,child.pid)).toThrow('unavailable')
    processes.sendIPC(parent.pid,child.pid,new Uint8Array([1]))
    processes.sendIPC(child.pid,child.pid,new Uint8Array([2]))
    processes.disconnectIPC(child.pid,child.pid)
    expect(await processes.receiveIPC(child.pid,child.pid)).toEqual(new Uint8Array([1]))
    expect(await processes.receiveIPC(parent.pid,child.pid)).toEqual(new Uint8Array([2]))
    expect(await processes.receiveIPC(parent.pid,child.pid)).toBeNull()
    expect(()=>processes.sendIPC(parent.pid,child.pid,new Uint8Array())).toThrow('closed')
    processes.kill(0,stranger.pid);await stranger.result
  }finally{processes.kill(0,parent.pid);await Promise.all([parent.result,child.result])}
})
test('parent termination releases pending IPC receivers in both directions',async()=>{
  const {processes,parent,child}=setup()
  const incoming=processes.receiveIPC(parent.pid,child.pid),outgoing=processes.receiveIPC(child.pid,child.pid)
  processes.kill(0,parent.pid)
  expect(await incoming).toBeNull();expect(await outgoing).toBeNull()
  await Promise.all([parent.result,child.result])
  expect(child.ipc?.toChild.queuedBytes).toBe(0)
  expect(child.ipc?.toParent.queuedBytes).toBe(0)
})
test('IPC cannot be created without a live managed parent',()=>{
  const processes=new GuestProcesses(async()=>result)
  expect(()=>processes.start(0,{...input,ipc:true})).toThrow('live parent')
})
