import {test,expect} from 'vitest'
import {spawn as nativeSpawn,exec as nativeExec} from 'node:child_process'
import {promisify} from 'node:util'
import '../src/sandbox/guest-task-queue.js'

// Exercise the guest facade with a native process transport, not a shell parser stub.
const records=new Map<number,any>(),calls:any[]=[]
let nextId=1
const host={reportError:(error:unknown)=>{throw error},proc:{
  call(method:string,...args:any[]){
    if(method==='shellSpawn'||method==='spawn'){
      const command=method==='shellSpawn'?args[0]:args[0],argv=method==='shellSpawn'?['-c',command]:args[1],settings=method==='shellSpawn'?args[1]:args[2],pid=nextId++,events:any[]=[]
      calls.push({command,settings})
      const child=nativeSpawn(method==='shellSpawn'?'/bin/sh':command,argv,{cwd:settings.cwd,env:settings.env,stdio:'pipe'})
      const record:any={child,events,reader:undefined};records.set(pid,record)
      const push=(event:any)=>{if(record.reader){const reader=record.reader;record.reader=undefined;reader(event)}else events.push(event)}
      child.stdout.on('data',bytes=>push({type:'stdout',bytes}))
      child.stderr.on('data',bytes=>push({type:'stderr',bytes}))
      child.on('close',(code,signal)=>push({type:'exit',code,signal}))
      return pid
    }
    const record=records.get(args[0])
    if(method==='kill')return record.child.kill(args[1])
    if(method==='end')return record.child.stdin.end()
    if(method==='forget')return records.delete(args[0])
    if(method==='ref')return args[1]?record.child.ref():record.child.unref()
    throw Error('Unexpected transport call '+method)
  },
  next(pid:number){const r=records.get(pid);return r.events.length?Promise.resolve(r.events.shift()):new Promise(resolve=>{r.reader=resolve})},
  write(pid:number,bytes:Uint8Array){return new Promise<void>((resolve,reject)=>records.get(pid).child.stdin.write(bytes,(error:Error)=>error?reject(error):resolve()))},
}}
;(globalThis as any).__webContainerHost=host
// @ts-expect-error The guest source intentionally has no host declaration file.
const guest=await import('../src/sandbox/guest-child-process.js')
const execute=promisify(guest.exec) as any

test('exec callback and promisify match native stdout and stderr',async()=>{
  expect(await execute('')).toEqual({stdout:'',stderr:''})
  const command="printf 'hello world'; printf warning >&2"
  const pending=execute(command)
  expect(pending.child).toBeInstanceOf(guest.ChildProcess)
  expect(await pending).toEqual(await promisify(nativeExec)(command))
  let count=0
  await new Promise<void>((resolve,reject)=>guest.exec(command,(error:any,stdout:string,stderr:string)=>{
    count++;try{expect(error).toBeNull();expect([stdout,stderr]).toEqual(['hello world','warning']);resolve()}catch(e){reject(e)}
  }))
  expect(count).toBe(1)
})
test('spawn shell keeps Node command-string semantics and streamed stdin',async()=>{
  const child=guest.spawn('read value; printf',['\'%s\'','"$value"'],{shell:true})
  const chunks:Buffer[]=[];child.stdout.on('data',(bytes:Buffer)=>chunks.push(bytes))
  const closed=new Promise(resolve=>child.on('close',resolve))
  child.stdin.end('two words\n');expect(await closed).toBe(0)
  expect(Buffer.concat(chunks).toString()).toBe('two words')
  expect(calls.at(-1).command).toBe('read value; printf \'%s\' "$value"')
})
test('exec errors retain status, command and captured output',async()=>{
  const command='printf output; printf problem >&2; exit 7'
  const actual=await execute(command).catch((error:any)=>error)
  const native=await promisify(nativeExec)(command).catch(error=>error)
  for(const key of ['code','signal','killed','cmd','message','stdout','stderr'])expect(actual[key]).toEqual(native[key])
})
test('encoding, environment, maxBuffer and unsupported shell paths',async()=>{
  const result=await execute('printf "$VALUE"',{env:{VALUE:'abc'},encoding:'buffer'})
  expect(result.stdout).toEqual(Buffer.from('abc'))
  await expect(execute('printf abcdef',{maxBuffer:3})).rejects.toMatchObject({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',stdout:'abc'})
  expect(()=>guest.spawn('true',[],{shell:'/bin/bash'})).toThrow('Shell path')
  expect(()=>guest.exec('true',{shell:'/bin/bash'})).toThrow('Shell path')
})
test('timeout and AbortSignal retain cancellation shape',async()=>{
  const command='read value'
  await expect(execute(command,{timeout:20})).rejects.toMatchObject({signal:'SIGTERM',killed:true,cmd:command})
  const controller=new AbortController(),pending=execute(command,{signal:controller.signal})
  controller.abort('cancelled')
  await expect(pending).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR',cause:'cancelled',cmd:command})
})
test('exit state, event order, kill results and references follow native controls',async()=>{
  const child=guest.spawn(process.execPath,['-e',"process.stdout.write('done');process.exitCode=6"]),events:any[]=[]
  child.on('exit',(code:number,signal:string)=>events.push(['exit',code,signal,child.exitCode,child.signalCode]))
  child.on('close',(code:number,signal:string)=>events.push(['close',code,signal,child.exitCode,child.signalCode]))
  child.unref().ref()
  await new Promise(resolve=>child.once('close',resolve))
  expect(events).toEqual([['exit',6,null,6,null],['close',6,null,6,null]])
  expect(child.kill()).toBe(false)

  const waiting=guest.spawn(process.execPath,['-e','setInterval(()=>{},1000)'])
  expect(waiting.kill(0)).toBe(true);expect(waiting.killed).toBe(true);expect(waiting.signalCode).toBe(null)
  expect(()=>waiting.kill('SIGUSR1')).toThrow(expect.objectContaining({code:'ERR_UNKNOWN_SIGNAL'}))
  expect(waiting.kill('sigint')).toBe(true)
  expect(await new Promise(resolve=>waiting.once('close',(code:number,signal:string)=>resolve([code,signal])))).toEqual([null,'SIGINT'])
})
test('AbortSignal validation and pre-aborted ordering follow Node controls',async()=>{
  expect(()=>guest.spawn(process.execPath,[],{signal:{addEventListener(){}}})).toThrow('Expected AbortSignal')
  expect(()=>guest.spawn(process.execPath,[],{killSignal:0})).toThrow(expect.objectContaining({code:'ERR_UNKNOWN_SIGNAL'}))
  const controller=new AbortController();controller.abort('already cancelled')
  const child=guest.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal}),events:string[]=[]
  child.on('spawn',()=>events.push('spawn'));child.on('error',(error:any)=>events.push(error.code));child.on('exit',()=>events.push('exit'))
  await new Promise(resolve=>child.once('close',resolve));events.push('close')
  expect(events).toEqual(['spawn','ABORT_ERR','exit','close'])
})
