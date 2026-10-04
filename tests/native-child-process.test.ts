import {expect,test,vi} from 'vitest'
import {EventEmitter} from 'events'
const workers=vi.hoisted(()=>({instances:[] as any[]}))
vi.mock('../src/native/worker-threads',()=>({Worker:class extends EventEmitter{
  threadId=1
  messages:unknown[]=[]
  constructor(readonly filename:string,readonly options:unknown){super();workers.instances.push(this)}
  postMessage(value:unknown){this.messages.push(value)}
  writeInput(){}
  disconnectIpc(){}
  async terminate(){this.emit('exit',0);return 0}
}}))
import {fork,spawn,execFile} from '../src/native/child-process'
import {ipcMessage} from '../src/native/ipc-message'
import browserProcess from 'process/browser'
import {NativeSharedInputSource,processInputSource,setProcessInputSource} from '../src/native/shared-input-source'
test('fork defaults inherit descriptors, silent uses pipes and explicit stdio wins',()=>{
  const previous=processInputSource,source=new NativeSharedInputSource()
  setProcessInputSource(source)
  try{
    const inherited=fork('child.js')
    expect([inherited.stdin,inherited.stdout,inherited.stderr]).toEqual([null,null,null])
    workers.instances.at(-1).emit('exit',0)
    const silent=fork('child.js',{silent:true})
    expect([silent.stdin,silent.stdout,silent.stderr].every(Boolean)).toBe(true)
    workers.instances.at(-1).emit('exit',0)
    const overridden=fork('child.js',{silent:true,stdio:'inherit'})
    expect([overridden.stdin,overridden.stdout,overridden.stderr]).toEqual([null,null,null])
    workers.instances.at(-1).emit('exit',0)
  }finally{source.close();setProcessInputSource(previous)}
})

test('fork accepts the explicit fourth IPC descriptor with real output pipes',()=>{
  const child=fork('child.js',[],{stdio:['pipe','pipe','pipe','ipc']})
  expect(child.stdin).not.toBeNull()
  expect(child.stdout).not.toBeNull()
  expect(child.stderr).not.toBeNull()
  expect(child.connected).toBe(true)
  expect(child.stdio).toEqual([child.stdin,child.stdout,child.stderr,null])
  const worker=workers.instances.at(-1),message=vi.fn()
  child.on('message',message)
  worker.emit('message',ipcMessage({answer:42},'json'))
  expect(message).toHaveBeenCalledWith({answer:42})
  worker.emit('exit',0)
})

test('fork rejects missing or unsupported IPC descriptors before creating a worker',()=>{
  const count=workers.instances.length
  expect(()=>fork('child.js',[],{stdio:['pipe','pipe','pipe']})).toThrow(expect.objectContaining({code:'ERR_CHILD_PROCESS_IPC_REQUIRED'}))
  expect(()=>fork('child.js',[],{stdio:['ipc','pipe','pipe']})).toThrow('Requested IPC descriptor placement')
  expect(()=>spawn('node',['child.js'],{stdio:['pipe','pipe','pipe','ipc']})).toThrow('Requested stdio mode')
  expect(workers.instances).toHaveLength(count)
})

test.each(['stdout','stderr'] as const)('inherited %s preserves bytes and waits for parent write completion',async(name)=>{
  const parent=browserProcess as typeof browserProcess & Record<string,unknown>
  const previous=parent[name]
  let finish!:(error?:Error)=>void
  const write=vi.fn((_bytes:unknown,done:(error?:Error)=>void)=>{finish=done;return false})
  parent[name]={write}
  try{
    const child=spawn('node',['child.js'],{stdio:['ignore','inherit','inherit']})
    const worker=workers.instances.at(-1),receipt=vi.fn(),closed=vi.fn()
    child.once('close',closed)
    expect([child.stdin,child.stdout,child.stderr]).toEqual([null,null,null])
    const bytes=new Uint8Array([0,128,255,10])
    worker.emit(name+'-bytes',bytes,receipt)
    expect(new Uint8Array(write.mock.calls[0][0] as Uint8Array)).toEqual(bytes)
    expect(receipt).not.toHaveBeenCalled()
    worker.emit('exit',0)
    await Promise.resolve()
    expect(closed).not.toHaveBeenCalled()
    finish()
    await Promise.resolve()
    expect(receipt).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
  }finally{parent[name]=previous}
})

test('inherited stdin without an input source is rejected before launching a worker',()=>{
  const count=workers.instances.length
  expect(()=>spawn('node',['child.js'],{stdio:['inherit','pipe','pipe']})).toThrow('Inherited stdin without a process input source')
  expect(workers.instances).toHaveLength(count)
})
test('inherited stdin uses shared read demand and does not send an early EOF',async()=>{
  const previous=processInputSource,source=new NativeSharedInputSource()
  setProcessInputSource(source)
  try{
    const child=spawn('node',['child.js'],{stdio:['inherit','pipe','pipe']})
    const worker=workers.instances.at(-1),write=vi.spyOn(worker,'writeInput')
    expect(child.stdin).toBeNull()
    worker.emit('online');expect(write).not.toHaveBeenCalled()
    const receipt=source.write(new Uint8Array([0,128,255]))
    worker.emit('input-demand');await receipt;await Promise.resolve()
    expect(write).toHaveBeenCalledWith(new Uint8Array([0,128,255]))
    await source.write(null);worker.emit('input-demand');await Promise.resolve();await Promise.resolve()
    expect(write).toHaveBeenLastCalledWith(null)
    worker.emit('exit',0)
  }finally{source.close();setProcessInputSource(previous)}
})

test('parent disconnect closes sends immediately and emits once on child acknowledgement',()=>{
  const child=fork('child.js',{silent:true}),worker=workers.instances.at(-1),control=vi.spyOn(worker,'disconnectIpc'),event=vi.fn(),error=vi.fn()
  child.on('disconnect',event);child.on('error',error)
  child.disconnect()
  expect(child.connected).toBe(false);expect(control).toHaveBeenCalledOnce();expect(event).not.toHaveBeenCalled()
  child.disconnect();expect(error.mock.calls[0][0]).toMatchObject({code:'ERR_IPC_DISCONNECTED'})
  worker.emit('disconnect');worker.emit('exit',0)
  expect(event).toHaveBeenCalledOnce()
  const spawned=spawn('node',['child.js'])
  expect(spawned.disconnect).toBeUndefined();workers.instances.at(-1).emit('exit',0)
})

test('child IPC disconnect reaches the parent once before exit',async()=>{
  const child=fork('child.js',{silent:true}),worker=workers.instances.at(-1),events:string[]=[]
  child.on('disconnect',()=>{expect(child.connected).toBe(false);events.push('disconnect')})
  child.on('exit',()=>events.push('exit'))
  worker.emit('disconnect')
  const callback=vi.fn()
  expect(child.send('late',callback)).toBe(false)
  await Promise.resolve()
  expect(callback.mock.calls[0][0]).toMatchObject({code:'ERR_IPC_CHANNEL_CLOSED'})
  worker.emit('disconnect');worker.emit('exit',0)
  expect(events).toEqual(['disconnect','exit'])
})

test('fork exit disconnects IPC but spawn has no disconnect event',()=>{
  const child=fork('child.js',{silent:true}),disconnected=vi.fn()
  child.on('disconnect',disconnected);workers.instances.at(-1).emit('exit',0)
  expect(disconnected).toHaveBeenCalledOnce()
  const spawned=spawn('node',['child.js']),unexpected=vi.fn()
  spawned.on('disconnect',unexpected);workers.instances.at(-1).emit('exit',0)
  expect(unexpected).not.toHaveBeenCalled()
})

test('piped stdin is destroyed before the child exit event',()=>{
  const child=spawn('node',['child.js'])
  const worker=workers.instances.at(-1)
  const exited=vi.fn(()=>{expect(child.stdin.destroyed).toBe(true);expect(child.stdin.writable).toBe(false)})
  child.once('exit',exited)
  worker.emit('exit',0)
  expect(exited).toHaveBeenCalledOnce()
})

test('ignored streams are null, stdin receives EOF, and ignored output is acknowledged',async()=>{
  const child=spawn('node',['child.js'],{stdio:'ignore'})
  const worker=workers.instances.at(-1)
  const input=vi.spyOn(worker,'writeInput')
  expect([child.stdin,child.stdout,child.stderr]).toEqual([null,null,null])
  worker.emit('online')
  expect(input).toHaveBeenCalledWith(null)
  const stdout=vi.fn(),stderr=vi.fn(),closed=vi.fn()
  child.on('close',closed)
  worker.emit('stdout-bytes',new Uint8Array([1,2]),stdout)
  worker.emit('stderr-bytes',new Uint8Array([3,4]),stderr)
  expect(stdout).toHaveBeenCalledOnce()
  expect(stderr).toHaveBeenCalledOnce()
  worker.emit('exit',0)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(closed).toHaveBeenCalledWith(0,null)
})

test('mixed pipe and ignore modes preserve the selected output stream',async()=>{
  const child=spawn('node',['child.js'],{stdio:['ignore','pipe','ignore']})
  expect(child.stdin).toBe(null)
  expect(child.stderr).toBe(null)
  let output=''
  child.stdout!.on('data',bytes=>{output+=bytes.toString()})
  const worker=workers.instances.at(-1)
  worker.emit('online');worker.emit('stdout','kept');worker.emit('exit',0)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(output).toBe('kept')
})

test('execFile keeps capture pipes even when passed ignored stdio',async()=>{
  const callback=vi.fn()
  execFile('node',['child.js'],{stdio:'ignore'},callback)
  const worker=workers.instances.at(-1)
  worker.emit('online');worker.emit('stdout','captured');worker.emit('exit',0)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(callback).toHaveBeenCalledWith(null,'captured','')
})

test('IPC defaults to JSON and advanced mode retains structured values',()=>{
  const value={date:new Date('2020-01-01'),omitted:undefined}
  expect(ipcMessage(value)).toEqual({date:'2020-01-01T00:00:00.000Z'})
  expect(ipcMessage(value,'advanced')).toBe(value)
  expect(()=>ipcMessage(()=>{})).toThrow()
})

test('fork carries arguments, forwards messages and reports exit and output',async()=>{
  const child=fork('/app/child.js',['hello'],{cwd:'/app',serialization:'advanced',silent:true})
  const worker=workers.instances.at(-1)
  expect(child.unref()).toBe(child)
  expect(child.ref()).toBe(child)
  expect(worker.options).toMatchObject({command:true,fork:true,argv:['hello'],cwd:'/app'})
  const messages:unknown[]=[]
  child.on('message',message=>messages.push(message))
  worker.emit('message',{answer:5})
  expect(messages).toEqual([{answer:5}])
  const sent=vi.fn()
  expect(child.send({input:2},sent)).toBe(true)
  await Promise.resolve()
  expect(sent).toHaveBeenCalledWith(null)
  expect(worker.messages).toEqual([{input:2}])
  const exits:unknown[]=[]
  child.on('exit',(code,signal)=>exits.push([code,signal]))
  worker.emit('exit',7)
  expect(exits).toEqual([[7,null]])
  expect(child.connected).toBe(false)
  const rejected=vi.fn()
  expect(child.send({},rejected)).toBe(false)
  await Promise.resolve()
  expect(rejected.mock.calls[0][0].code).toBe('ERR_IPC_CHANNEL_CLOSED')
})

test('kill reports a signal once and unsupported executable flags fail clearly',()=>{
  const child=fork('/app/child.js',[],{cwd:'/app',silent:true})
  const exited=vi.fn()
  child.on('exit',exited)
  expect(child.kill()).toBe(true)
  expect(child.kill()).toBe(false)
  expect(exited).toHaveBeenCalledWith(null,'SIGTERM')
  expect(()=>fork('/app/child.js',[],{execArgv:['--inspect']})).toThrow('Unsupported or incomplete Node launch flag')
})

test('fork output preserves arbitrary bytes',()=>{
  const child=fork('/app/child.js',[],{cwd:'/app',silent:true})
  const worker=workers.instances.at(-1)
  const output:number[]=[]
  child.stdout.on('data',chunk=>output.push(...chunk))
  worker.emit('stdout-bytes',new Uint8Array([0xff,0,0xf0]))
  worker.emit('stdout-bytes',new Uint8Array([0x9f,0x98,0x80]))
  expect(output).toEqual([0xff,0,0xf0,0x9f,0x98,0x80])
  worker.emit('exit',0)
})
test('fork accepts file URL module paths',()=>{
  const child=fork(new URL('file:///app/child.js'),{silent:true})
  const worker=workers.instances.at(-1)
  expect(worker.filename).toBe('/app/child.js')
  worker.emit('exit',0)
  expect(()=>fork(new URL('https://example.test/child.js'))).toThrow()
})

test('spawn launches a Node script without a fork IPC channel and does not inherit execArgv',()=>{
  const child=spawn('/usr/bin/node',['--conditions=custom','-r','./preload.cjs','script.js','--script-option'],{cwd:'/app',env:{EXAMPLE:'yes'}})
  const worker=workers.instances.at(-1)
  expect(worker.filename).toBe('/app/script.js')
  expect(worker.options).toMatchObject({fork:false,execArgv:['--conditions=custom','-r','./preload.cjs'],
    argv:['--script-option'],cwd:'/app',env:{EXAMPLE:'yes'}})
  expect(child.connected).toBe(false)
  expect(child.send).toBeUndefined()
  worker.emit('exit',0)
})

test('spawn rejects unsupported executables and flags rather than changing their meaning',()=>{
  expect(()=>spawn('git',['status'])).toThrow('Executable git')
  expect(()=>spawn('node',['--inspect','script.js'])).toThrow('Unsupported or incomplete Node launch flag')
  expect(()=>spawn('node',[])).toThrow('Interactive Node')
  expect(()=>spawn('node',['script.js'],{shell:true})).toThrow('Shell execution')
})

test('close waits for stdout and stderr end and drains unread output after exit',async()=>{
  const child=spawn('node',['script.js'],{cwd:'/app'})
  const worker=workers.instances.at(-1),events:string[]=[]
  child.stdout.once('end',()=>events.push('stdout-end'))
  child.stderr.once('end',()=>events.push('stderr-end'))
  child.once('exit',()=>events.push('exit'))
  const closed=new Promise(resolve=>child.once('close',()=>{events.push('close');resolve(null)}))
  worker.emit('stdout-bytes',new Uint8Array([255,0]))
  worker.emit('stderr-bytes',new Uint8Array([1]))
  worker.emit('exit',0)
  expect(events).toEqual(['exit'])
  await closed
  expect(events.at(-1)).toBe('close')
  expect(events).toContain('stdout-end')
  expect(events).toContain('stderr-end')
})

test('execFile collects raw buffers and calls back once after close',async()=>{
  const callback=vi.fn()
  const done=new Promise<void>(resolve=>execFile('node',['script.js'],{encoding:'buffer'},(error,stdout,stderr)=>{
    callback(error,[...stdout],[...stderr]);resolve()
  }))
  const worker=workers.instances.at(-1)
  worker.emit('stdout-bytes',new Uint8Array([255,0,240]));worker.emit('stdout-bytes',new Uint8Array([159,152,128]))
  worker.emit('stderr-bytes',new Uint8Array([1]));worker.emit('exit',0)
  await done
  expect(callback).toHaveBeenCalledExactlyOnceWith(null,[255,0,240,159,152,128],[1])
})

test('execFile preserves failure output and exit status',async()=>{
  const done=new Promise<any>(resolve=>execFile('node',['script.js'],(error,stdout,stderr)=>resolve({error,stdout,stderr})))
  const worker=workers.instances.at(-1)
  worker.emit('stdout-bytes',new TextEncoder().encode('before'))
  worker.emit('stderr-bytes',new TextEncoder().encode('detail'));worker.emit('exit',7)
  const result=await done
  expect(result.error).toMatchObject({code:7,killed:false,signal:null,cmd:'node script.js'})
  expect(result.stdout).toBe('before');expect(result.stderr).toBe('detail')
})

test('execFile enforces output limits and validates limits before launch',async()=>{
  const done=new Promise<any>(resolve=>execFile('node',['script.js'],{maxBuffer:4},(error,stdout)=>resolve({error,stdout})))
  workers.instances.at(-1).emit('stdout-bytes',new TextEncoder().encode('123456789'))
  const result=await done
  expect(result.error).toMatchObject({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',cmd:'node script.js'})
  expect(result.stdout).toBe('1234')
  expect(()=>execFile('node',['script.js'],{maxBuffer:-1})).toThrow('Invalid maxBuffer')
  expect(()=>execFile('node',['script.js'],{timeout:-1})).toThrow('Invalid timeout')
})

test('spawn abort preserves its reason and removes the listener after exit',async()=>{
  const controller=new AbortController(),reason=Error('cancelled'),remove=vi.spyOn(controller.signal,'removeEventListener')
  const child=spawn('node',['script.js'],{signal:controller.signal})
  const error=vi.fn(),exit=vi.fn()
  child.on('error',error);child.on('exit',exit)
  controller.abort(reason)
  expect(error.mock.calls[0][0]).toMatchObject({name:'AbortError',code:'ABORT_ERR',cause:reason})
  expect(exit).toHaveBeenCalledExactlyOnceWith(null,'SIGTERM')
  expect(remove).toHaveBeenCalledTimes(1)
  controller.abort(reason)
  expect(error).toHaveBeenCalledTimes(1)
})

test('pre-aborted spawn delivers its error asynchronously and finished children ignore abort',async()=>{
  const controller=new AbortController();controller.abort('before launch')
  const child=spawn('node',['script.js'],{signal:controller.signal}),error=vi.fn()
  child.on('error',error)
  expect(error).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(error.mock.calls[0][0]).toMatchObject({code:'ABORT_ERR',cause:'before launch'})
  const late=new AbortController(),completed=spawn('node',['script.js'],{signal:late.signal}),unexpected=vi.fn()
  completed.on('error',unexpected);workers.instances.at(-1).emit('exit',0);late.abort('after exit')
  expect(unexpected).not.toHaveBeenCalled()
})

test('spawn passes eval source and arguments through the existing command evaluator',()=>{
  const source='console.log(42)',child=spawn('node',['-e',source,'space value'])
  const worker=workers.instances.at(-1)
  expect(worker.options).toMatchObject({evalSource:source,execArgv:['-e',source],argv:['space value'],fork:false})
  worker.emit('exit',0)
  expect(()=>spawn('node',['-e'])).toThrow('Incomplete launch flag')
})
test('spawn selects source-on-stdin without treating the dash as a Node flag',()=>{
  const child=spawn('node',['-','space value'])
  const worker=workers.instances.at(-1)!
  expect(worker.options).toMatchObject({stdinSource:true,execArgv:[],argv:['space value'],fork:false})
  child.kill()
})
