import {expect,it} from 'vitest'
import {Buffer} from 'node:buffer'
import {Volume} from 'memfs'
import {EventEmitter} from 'events'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'
import {NativeTerminalProcesses} from '../src/native/terminal-processes'

const setup=()=>{
  const volume=Volume.fromJSON({'/app/answer.txt':'forty two\n'})
  const files=new NativeTerminalFileSession(volume)
  const processes=new NativeTerminalProcesses(volume,files)
  return {files,processes,volume}
}

it('streams a large file without killing cat when consumption starts later',async()=>{
  const {files,processes,volume}=setup()
  const bytes=Uint8Array.from({length:4*1024*1024},(_,index)=>index%251)
  volume.writeFileSync('/app/large.bin',bytes)
  try{
    const pid=processes.call('process.spawn',[['cat','large.bin'],'/app',{}]) as number
    await new Promise(resolve=>setTimeout(resolve,0))
    let offset=0
    for(;;){
      const event=await processes.call('process.next',[pid]) as {type:string;bytes?:Uint8Array;code?:number}|null
      expect(event).not.toBeNull()
      if(event!.type==='exit'){expect(event!.code).toBe(0);break}
      const expected=bytes.subarray(offset,offset+event!.bytes!.length)
      expect(Buffer.compare(Buffer.from(event!.bytes!),Buffer.from(expected))).toBe(0)
      offset+=event!.bytes!.length
    }
    expect(offset).toBe(bytes.length)
  }finally{processes.close();files.close()}
})

it('disposes cat while it waits for its output consumer',async()=>{
  const {files,processes,volume}=setup()
  volume.writeFileSync('/app/large.bin',new Uint8Array(4*1024*1024))
  try{
    const pid=processes.call('process.spawn',[['cat','large.bin'],'/app',{}]) as number
    await new Promise(resolve=>setTimeout(resolve,0))
    processes.call('process.dispose',[pid])
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(()=>processes.call('process.next',[pid])).toThrow('Unknown shell child')
  }finally{processes.close();files.close()}
})

it('holds stdin writes while cat waits for its output consumer',async()=>{
  const {files,processes}=setup()
  try{
    const pid=processes.call('process.spawn',[['cat'],'/app',{}]) as number
    await processes.call('process.write',[pid,new Uint8Array([1])])
    let consumed=false
    const pending=Promise.resolve(processes.call('process.write',[pid,new Uint8Array([2])])).then(()=>{consumed=true})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(consumed).toBe(false)
    expect(await processes.call('process.next',[pid])).toEqual({type:'stdout',bytes:new Uint8Array([1])})
    await pending
    processes.call('process.end',[pid])
    expect(await processes.call('process.next',[pid])).toEqual({type:'stdout',bytes:new Uint8Array([2])})
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
  }finally{processes.close();files.close()}
})

it('streams a project file through an owned child process',async()=>{
  const {files,processes}=setup()
  try{
    const pid=processes.call('process.spawn',[['cat','answer.txt'],'/app',{}]) as number
    await expect(processes.call('process.next',[pid])).resolves.toEqual({type:'stdout',bytes:new TextEncoder().encode('forty two\n')})
    await expect(processes.call('process.next',[pid])).resolves.toEqual({type:'exit',code:0})
    expect(await processes.call('process.next',[pid])).toBeNull()
    processes.call('process.dispose',[pid])
  }finally{processes.close();files.close()}
})

it('streams stdin to cat and rejects unknown programs',async()=>{
  const {files,processes}=setup()
  try{
    expect(()=>processes.call('process.spawn',[['missing'],'/app',{}])).toThrow('Command not found')
    const pid=processes.call('process.spawn',[['cat'],'/app',{}]) as number
    processes.call('process.write',[pid,new TextEncoder().encode('hello')])
    processes.call('process.end',[pid])
    expect(await processes.call('process.next',[pid])).toEqual({type:'stdout',bytes:new TextEncoder().encode('hello')})
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
  }finally{processes.close();files.close()}
})

it('runs pnpm install in the live workspace and keeps the process output',async()=>{
  const volume=Volume.fromJSON({'/app/package.json':'{}'})
  const files=new NativeTerminalFileSession(volume)
  let calls=0
  const processes=new NativeTerminalProcesses(volume,files,undefined,undefined,undefined,
    async(_signal,progress)=>{calls++;progress('Installed 1/1 packages...\n')})
  try{
    const pid=processes.call('process.spawn',[['pnpm','install'],'/app',{}]) as number
    const output:string[]=[]
    for(;;){
      const event=await processes.call('process.next',[pid]) as {type:string;bytes?:Uint8Array;code?:number}|null
      if(!event)break
      if(event.bytes)output.push(new TextDecoder().decode(event.bytes))
      if(event.type==='exit'){expect(event.code).toBe(0);break}
    }
    expect(calls).toBe(1)
    expect(output.join('')).toContain('Installed 1/1 packages...')
    expect([...files.changedPaths]).toContain('/app/node_modules')
  }finally{processes.close();files.close()}
})

it('runs essential file commands against the shared volume',async()=>{
  const {files,processes}=setup()
  const execute=async(argv:string[])=>{
    const pid=processes.call('process.spawn',[argv,'/app',{}]) as number
    const events=[]
    for(;;){
      const event=await processes.call('process.next',[pid]) as {type:string;bytes?:Uint8Array}|null
      if(!event)break
      events.push(event)
      if(event.type==='exit')break
    }
    processes.call('process.dispose',[pid])
    return events
  }
  try{
    expect((await execute(['mkdir','sub'])).at(-1)).toEqual({type:'exit',code:0})
    expect((await execute(['touch','sub/new.txt'])).at(-1)).toEqual({type:'exit',code:0})
    expect((await execute(['cp','answer.txt','sub/copy.txt'])).at(-1)).toEqual({type:'exit',code:0})
    expect((await execute(['ls','sub'])).map(event=>event.type==='stdout'?new TextDecoder().decode(event.bytes!):event)).toEqual([
      'copy.txt  new.txt\n',{type:'exit',code:0},
    ])
    expect((await execute(['mv','sub/copy.txt','sub/moved.txt'])).at(-1)).toEqual({type:'exit',code:0})
    expect((await execute(['rm','sub/moved.txt'])).at(-1)).toEqual({type:'exit',code:0})
    expect([...files.changedPaths]).toEqual(['/app/sub','/app/sub/new.txt','/app/sub/copy.txt','/app/sub/moved.txt'])
  }finally{processes.close();files.close()}
})

it('copies, moves, and removes directory trees without leaving the project',async()=>{
  const volume=Volume.fromJSON({'/app/tree/nested/file.txt':'data'})
  const files=new NativeTerminalFileSession(volume)
  const processes=new NativeTerminalProcesses(volume,files)
  const execute=async(argv:string[])=>{
    const pid=processes.call('process.spawn',[argv,'/app',{}]) as number
    const events=[]
    for(;;){
      const event=await processes.call('process.next',[pid]) as {type:string;bytes?:Uint8Array;code?:number}|null
      if(!event)break
      events.push(event)
      if(event.type==='exit')break
    }
    processes.call('process.dispose',[pid])
    return events
  }
  try{
    expect((await execute(['cp','tree','copy'])).at(-1)).toEqual({type:'exit',code:1})
    expect((await execute(['cp','-r','tree','copy'])).at(-1)).toEqual({type:'exit',code:0})
    expect(volume.readFileSync('/app/copy/nested/file.txt','utf8')).toBe('data')
    expect([...files.changedPaths]).toContain('/app/copy/nested/file.txt')
    expect((await execute(['cp','-r','tree','tree/nested/again'])).at(-1)).toEqual({type:'exit',code:1})
    expect((await execute(['mv','copy','moved'])).at(-1)).toEqual({type:'exit',code:0})
    expect(volume.existsSync('/app/copy')).toBe(false)
    expect(volume.readFileSync('/app/moved/nested/file.txt','utf8')).toBe('data')
    expect([...files.changedPaths]).toContain('/app/copy/nested/file.txt')
    expect([...files.changedPaths]).toContain('/app/moved/nested/file.txt')
    expect((await execute(['rm','moved'])).at(-1)).toEqual({type:'exit',code:1})
    expect((await execute(['rm','-r','moved'])).at(-1)).toEqual({type:'exit',code:0})
    expect(volume.existsSync('/app/moved')).toBe(false)
    expect((await execute(['rm','-rf','missing'])).at(-1)).toEqual({type:'exit',code:0})
    expect((await execute(['rm','-rf','/app'])).at(-1)).toEqual({type:'exit',code:1})
    expect(volume.existsSync('/app/tree/nested/file.txt')).toBe(true)
  }finally{processes.close();files.close()}
})

it('ends an abortable foreground sleep process',async()=>{
  const {files,processes}=setup()
  try{
    const pid=processes.call('process.spawn',[['sleep','10'],'/app',{}]) as number
    processes.call('process.kill',[pid])
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:137})
  }finally{processes.close();files.close()}
})

it('reports the latest terminal size to a child process',async()=>{
  const {files,processes}=setup()
  try{
    processes.resize(132,41)
    const pid=processes.call('process.spawn',[['stty','size'],'/app',{}]) as number
    expect(await processes.call('process.next',[pid])).toEqual({type:'stdout',bytes:new TextEncoder().encode('41 132\n')})
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
  }finally{processes.close();files.close()}
})

it('connects an isolated node worker to shell output, input, exit, and changed paths',async()=>{
  const volume=Volume.fromJSON({'/app/script.mjs':'console.log("hello")'})
  const files=new NativeTerminalFileSession(volume)
  const worker=Object.assign(new EventEmitter(),{
    changedPaths:['/app/output.txt'],
    input:[] as Array<Uint8Array|null>,
    writeInput(bytes:Uint8Array|null){this.input.push(bytes)},
    async terminate(){return 0},
  })
  const processes=new NativeTerminalProcesses(volume,files,(_entry,options)=>{
    expect(options).toEqual({argv:['arg'],cwd:'/app',env:{},execArgv:[]})
    return worker
  })
  try{
    const pid=processes.call('process.spawn',[['node','script.mjs','arg'],'/app',{}]) as number
    processes.call('process.write',[pid,new TextEncoder().encode('input')])
    processes.call('process.end',[pid])
    await new Promise(resolve=>setTimeout(resolve,0))
    worker.emit('stdout','hello\n')
    worker.emit('exit',0)
    expect(await processes.call('process.next',[pid])).toEqual({type:'stdout',bytes:new TextEncoder().encode('hello\n')})
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
    expect(worker.input).toEqual([new TextEncoder().encode('input'),null])
    expect([...files.changedPaths]).toEqual(['/app/output.txt'])
  }finally{processes.close();files.close()}
})

it('passes node -e source and arguments to an isolated command worker',async()=>{
  const volume=Volume.fromJSON({'/app/package.json':'{}'})
  const files=new NativeTerminalFileSession(volume)
  let selected:{entry:string;options:unknown}|undefined
  const processes=new NativeTerminalProcesses(volume,files,(entry,options)=>{
    selected={entry,options}
    const worker=Object.assign(new EventEmitter(),{
      changedPaths:[],writeInput(_bytes:Uint8Array|null){},async terminate(){return 0},
    })
    queueMicrotask(()=>worker.emit('exit',0))
    return worker
  })
  try{
    const pid=processes.call('process.spawn',[['node','-e','console.log(process.argv[1])','hello'],'/app',{}]) as number
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
    expect(selected).toEqual({entry:'/app/__native_eval__.cjs',options:{argv:['hello'],cwd:'/app',env:{},
      execArgv:['-e','console.log(process.argv[1])'],evalSource:'console.log(process.argv[1])'}})
  }finally{processes.close();files.close()}
})

it('node command output crosses terminal processes without decoding',async()=>{
  const volume=Volume.fromJSON({'/app/package.json':'{}'})
  const files=new NativeTerminalFileSession(volume)
  const processes=new NativeTerminalProcesses(volume,files,()=>{
    const worker=Object.assign(new EventEmitter(),{
      changedPaths:[],writeInput(){},async terminate(){return 0},
    })
    queueMicrotask(()=>{
      worker.emit('stdout-bytes',new Uint8Array([0xff,0,0xf0,0x9f,0x98,0x80]))
      worker.emit('exit',0)
    })
    return worker
  })
  try{
    const pid=processes.call('process.spawn',[['node','-e','0'],'/app',{}]) as number
    expect(await processes.call('process.next',[pid])).toEqual({type:'stdout',bytes:new Uint8Array([0xff,0,0xf0,0x9f,0x98,0x80])})
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
  }finally{processes.close();files.close()}
})

it('runs JavaScript supplied on stdin with node -',async()=>{
  const volume=Volume.fromJSON({'/app/package.json':'{}'})
  const files=new NativeTerminalFileSession(volume)
  let selected:{entry:string;options:unknown}|undefined
  const processes=new NativeTerminalProcesses(volume,files,(entry,options)=>{
    selected={entry,options}
    const worker=Object.assign(new EventEmitter(),{
      changedPaths:[],input:[] as Array<Uint8Array|null>,
      writeInput(bytes:Uint8Array|null){this.input.push(bytes)},async terminate(){return 0},
    })
    queueMicrotask(()=>worker.emit('exit',0))
    return worker
  })
  try{
    const pid=processes.call('process.spawn',[['node','-','hello'],'/app',{}]) as number
    processes.call('process.write',[pid,new TextEncoder().encode('console.log(')])
    processes.call('process.write',[pid,new TextEncoder().encode('process.argv[1])')])
    processes.call('process.end',[pid])
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
    expect(selected).toEqual({entry:'/app/__native_stdin__.cjs',options:{argv:['hello'],cwd:'/app',env:{},execArgv:[],stdinSource:true}})
  }finally{processes.close();files.close()}
})

it('resolves a package bin symlink from the script PATH and runs its Node entry',async()=>{
  const volume=Volume.fromJSON({'/app/node_modules/tool/bin.mjs':'#!/usr/bin/env node\nconsole.log("tool")'})
  volume.mkdirSync('/app/node_modules/.bin')
  volume.symlinkSync('/app/node_modules/tool/bin.mjs','/app/node_modules/.bin/tool')
  const files=new NativeTerminalFileSession(volume)
  let selected:{entry:string;options:unknown}|undefined
  const processes=new NativeTerminalProcesses(volume,files,(entry,options)=>{
    selected={entry,options}
    const worker=Object.assign(new EventEmitter(),{
      changedPaths:[],
      writeInput(_bytes:Uint8Array|null){},
      async terminate(){return 0},
    })
    queueMicrotask(()=>{worker.emit('stdout','tool\n');worker.emit('exit',0)})
    return worker
  })
  try{
    const pid=processes.call('process.spawn',[['tool','hello'],'/app',{PATH:'/project/node_modules/.bin'}]) as number
    expect(await processes.call('process.next',[pid])).toEqual({type:'stdout',bytes:new TextEncoder().encode('tool\n')})
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:0})
    expect(selected).toEqual({entry:'/app/node_modules/tool/bin.mjs',options:{argv:['hello'],cwd:'/app',
      execArgv:[],env:{PATH:'/project/node_modules/.bin'}}})
  }finally{processes.close();files.close()}
})

it('reports a non-Node package bin without executing it',async()=>{
  const volume=Volume.fromJSON({'/app/node_modules/tool/bin.py':'#!/usr/bin/env python\nprint("no")'})
  volume.mkdirSync('/app/node_modules/.bin')
  volume.symlinkSync('/app/node_modules/tool/bin.py','/app/node_modules/.bin/tool')
  const files=new NativeTerminalFileSession(volume)
  const processes=new NativeTerminalProcesses(volume,files,()=>{throw Error('Non-Node executable was launched')})
  try{
    const pid=processes.call('process.spawn',[['tool'],'/app',{PATH:'/project/node_modules/.bin'}]) as number
    const error=await processes.call('process.next',[pid]) as {type:string;bytes:Uint8Array}
    expect(error.type).toBe('stderr')
    expect(new TextDecoder().decode(error.bytes)).toContain('Unsupported package executable interpreter')
    expect(await processes.call('process.next',[pid])).toEqual({type:'exit',code:126})
  }finally{processes.close();files.close()}
})
