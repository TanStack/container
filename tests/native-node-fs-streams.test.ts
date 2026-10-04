import {expect,test} from 'vitest'
import {Buffer} from 'buffer'
import fs,{getNativeSyncFileClient,setNativeSyncFileClient,resetVolume} from '../src/vite-browser/node-fs'
import {createNativeFilesystemBackend} from '../src/native/filesystem-backend.mjs'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'
import {runFilesystemStreamControl} from './fixtures/native-filesystem-stream-workload.mjs'
import {beginNodeCommandTimerActivity} from '../src/vite-browser/node-timers'

for(const bridge of [false,true])test(`ordinary Node file streams pass the complete workload, ${bridge?'child bridge':'local volume'}`,async()=>{
  const previous=getNativeSyncFileClient(),{vol}=createNativeFilesystemBackend({'/app/package.json':'{}'})
  const session=bridge?new NativeTerminalFileSession(vol):undefined
  setNativeSyncFileClient(session?{call:(method:string,args:unknown[])=>session.call(method,args)} as any:undefined)
  if(!bridge)resetVolume({'/app/package.json':'{}'})
  try{
    const result=await runFilesystemStreamControl(fs,fs)
    expect(result.passed).toBe(true);expect(result.checks).toHaveLength(14)
    const stream=new fs.ReadStream('/app/stream.txt',{start:1,end:2})
    expect(stream).toBeInstanceOf(fs.ReadStream)
    let text='';for await(const chunk of stream)text+=chunk.toString()
    expect(text).toBe('bc')
    const writer=new fs.WriteStream('/app/constructor.txt')
    expect(writer).toBeInstanceOf(fs.WriteStream)
    const closed=new Promise<void>((resolve,reject)=>{writer.once('close',resolve);writer.once('error',reject)})
    writer.end('constructor');await closed
    expect(fs.readFileSync('/app/constructor.txt','utf8')).toBe('constructor')
    expect(()=>fs.fstatSync(writer.fd!)).toThrow()
    const input=await fs.promises.open('/app/constructor.txt','r')
    const handled=fs.createReadStream(undefined,{fd:input,start:1,end:3})
    let handledText='';for await(const chunk of handled)handledText+=chunk.toString()
    expect(handledText).toBe('ons');expect(input.fd).toBe(-1)
    const output=await fs.promises.open('/app/handled.txt','w')
    const handledWriter=fs.createWriteStream(undefined,{fd:output,flush:true})
    const handledClosed=new Promise<void>((resolve,reject)=>{handledWriter.once('close',resolve);handledWriter.once('error',reject)})
    handledWriter.end('handled');await handledClosed
    expect(fs.readFileSync('/app/handled.txt','utf8')).toBe('handled');expect(output.fd).toBe(-1)
    await output.close()
  }finally{setNativeSyncFileClient(previous);session?.close()}
})

test('an unread paused file stream does not keep a command alive after opening',async()=>{
  const previous=getNativeSyncFileClient();setNativeSyncFileClient(undefined)
  resetVolume({'/app/paused.txt':'hello'})
  const activity=beginNodeCommandTimerActivity(),stream=fs.createReadStream('/app/paused.txt')
  try{
    await activity.waitForIdle()
    expect(stream.fd).not.toBeNull();expect(stream.readableFlowing).not.toBe(true)
    const closed=new Promise<void>(resolve=>stream.once('close',resolve));stream.destroy();await closed
    await activity.waitForIdle()
  }finally{stream.destroy();activity.stop();setNativeSyncFileClient(previous)}
})

test('a delayed write and descriptor close keep a command alive until their callbacks settle',async()=>{
  const previous=getNativeSyncFileClient();setNativeSyncFileClient(undefined)
  resetVolume({'/app/package.json':'{}'})
  const activity=beginNodeCommandTimerActivity(),events:string[]=[]
  const stream=fs.createWriteStream('/app/delayed.txt',{fs:{
    open:fs.open,write(fd:number,buffer:Buffer,offset:number,length:number,position:number|null,done:Function){
      setTimeout(()=>{const bytes=fs.writeSync(fd,buffer,offset,length,position);events.push('write');done(null,bytes,buffer)},10)
    },close(fd:number,done:Function){setTimeout(()=>{fs.closeSync(fd);events.push('close');done(null)},10)},
  }})
  try{
    const closed=new Promise<void>((resolve,reject)=>{stream.once('close',resolve);stream.once('error',reject)})
    stream.end('hello');await activity.waitForIdle();events.push('idle');await closed
    expect(events).toEqual(['write','close','idle'])
    expect(fs.readFileSync('/app/delayed.txt','utf8')).toBe('hello')
  }finally{stream.destroy();activity.stop();setNativeSyncFileClient(previous)}
})

test('ordinary file writers apply their declared encoding before writing',async()=>{
  const previous=getNativeSyncFileClient();setNativeSyncFileClient(undefined)
  resetVolume({'/app/package.json':'{}'})
  try{
    const stream=fs.createWriteStream('/app/encoded.txt',{encoding:'utf16le'})
    const closed=new Promise<void>((resolve,reject)=>{stream.once('close',resolve);stream.once('error',reject)})
    stream.end('é雪');await closed
    expect(fs.readFileSync('/app/encoded.txt')).toEqual(Buffer.from('é雪','utf16le'))
    expect(()=>fs.createWriteStream('/app/invalid.txt',{encoding:'wrong' as any})).toThrow(expect.objectContaining({code:'ERR_UNKNOWN_ENCODING'}))
    expect(fs.existsSync('/app/invalid.txt')).toBe(false)
  }finally{setNativeSyncFileClient(previous)}
})
