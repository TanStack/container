import {expect,test} from 'vitest'
import {createRequire} from 'node:module'
import {openSync as nativeOpenSync,closeSync as nativeCloseSync,fstatSync as nativeFstatSync} from 'node:fs'
import {Volume} from 'memfs'
import fs,{getNativeSyncFileClient,setNativeSyncFileClient,resetVolume} from '../src/vite-browser/node-fs'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'

const require=createRequire(import.meta.url)
const {WASI}=require('@napi-rs/wasm-runtime')
const reactor=new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,5,3,1,0,1,
  7,10,1,6,109,101,109,111,114,121,2,0,
]))

test('the local backend opens its root directory like Node',()=>{
  const fd=nativeOpenSync('/','r')
  try{expect(nativeFstatSync(fd).isDirectory()).toBe(true)}finally{nativeCloseSync(fd)}
  const previous=getNativeSyncFileClient()
  setNativeSyncFileClient(undefined)
  try{
    resetVolume({})
    expect(fs.statSync('/').isDirectory()).toBe(true)
    const local=fs.openSync('/','r')
    try{expect(fs.fstatSync(local,{bigint:true}).isDirectory()).toBe(true)}
    finally{fs.closeSync(local)}
  }finally{setNativeSyncFileClient(previous)}
})

for(const live of [false,true]){
  test(`descriptor stat forwards bigint options, ${live?'live bridge':'local volume'}`,async()=>{
    const previous=getNativeSyncFileClient()
    const volume=Volume.fromJSON({'/app/input.txt':'content'})
    const session=new NativeTerminalFileSession(volume)
    setNativeSyncFileClient(undefined)
    resetVolume({'/app/input.txt':'content'})
    if(live)setNativeSyncFileClient({call:(method:string,args:unknown[])=>session.call(method,args)} as any)
    const fd=fs.openSync('/app/input.txt','r')
    try{
      expect(typeof fs.fstatSync(fd).size).toBe('number')
      const stat=fs.fstatSync(fd,{bigint:true})
      expect(stat.size).toBe(7n)
      expect(typeof stat.ino).toBe('bigint')
      expect(typeof stat.mtimeMs).toBe('bigint')
      expect(stat.isFile()).toBe(true)
      const callbackStat=await new Promise<any>((resolve,reject)=>
        fs.fstat(fd,{bigint:true},(error,value)=>error?reject(error):resolve(value)))
      expect(callbackStat.size).toBe(7n)
      expect(typeof callbackStat.mtimeMs).toBe('bigint')
      const handle=await fs.promises.open('/app/input.txt','r')
      try{expect((await handle.stat({bigint:true})).size).toBe(7n)}
      finally{await handle.close()}
    }finally{fs.closeSync(fd);setNativeSyncFileClient(previous);session.close()}
  })

  test(`installed compiler WASI consumes descriptor stats, ${live?'live bridge':'local volume'}`,()=>{
    const previous=getNativeSyncFileClient()
    const volume=Volume.fromJSON({'/app/input.txt':'content'})
    const session=new NativeTerminalFileSession(volume)
    setNativeSyncFileClient(undefined)
    resetVolume({'/app/input.txt':'content'})
    if(live)setNativeSyncFileClient({call:(method:string,args:unknown[])=>session.call(method,args)} as any)
    // Keep the original /app control alongside the root mount-lifetime control.
    const wasi=new WASI({version:'preview1',fs,preopens:{'/app':'/app'}})
    const instance=new WebAssembly.Instance(reactor)
    wasi.initialize(instance)
    try{
      expect(wasi.wasiImport.fd_filestat_get(3,64)).toBe(0)
      const view=new DataView((instance.exports.memory as WebAssembly.Memory).buffer)
      expect(view.getUint8(80)).toBe(3)
      expect(view.getBigUint64(88,true)).toBeGreaterThan(0n)
    }finally{
      expect(wasi.wasiImport.fd_close(3)).toBe(0)
      setNativeSyncFileClient(previous);session.close()
    }
  })
}

test('workspace mounts preserve the compiler root and do not retarget open files',()=>{
  const previous=getNativeSyncFileClient()
  setNativeSyncFileClient(undefined)
  resetVolume({'/app/input.txt':'old'})
  const root=fs.openSync('/','r')
  const input=fs.openSync('/app/input.txt','r')
  const inode=fs.fstatSync(root).ino
  const wasi=new WASI({version:'preview1',fs,preopens:{'/':'/'}})
  const instance=new WebAssembly.Instance(reactor)
  wasi.initialize(instance)
  const view=new DataView((instance.exports.memory as WebAssembly.Memory).buffer)
  try{
    for(let mount=0;mount<3;mount++){
      resetVolume({'/app/input.txt':`new-${mount}`,[`/app/mount-${mount}.txt`]:'next'})
      expect(fs.fstatSync(root).ino).toBe(inode)
      // Inspect the retained bytes without consuming the descriptor again.
      // Like Node, whole-file reads from an fd now advance that fd's cursor.
      const retained=Buffer.alloc(3)
      expect(fs.readSync(input,retained,0,retained.length,0)).toBe(3)
      expect(retained.toString()).toBe('old')
      expect(fs.readFileSync(input,'utf8')).toBe(mount===0?'old':'')
      expect(fs.readFileSync('/app/input.txt','utf8')).toBe(`new-${mount}`)
      expect(wasi.wasiImport.fd_filestat_get(3,64)).toBe(0)
      expect(view.getUint8(80)).toBe(3)
      const name=new TextEncoder().encode(`app/mount-${mount}.txt`)
      new Uint8Array(view.buffer).set(name,256)
      expect(wasi.wasiImport.path_filestat_get(3,1,256,name.length,64)).toBe(0)
      expect(view.getUint8(80)).toBe(4)
      expect(view.getBigUint64(96,true)).toBe(4n)
      if(mount)expect(fs.existsSync(`/app/mount-${mount-1}.txt`)).toBe(false)
    }
  }finally{
    expect(wasi.wasiImport.fd_close(3)).toBe(0)
    fs.closeSync(input);fs.closeSync(root);setNativeSyncFileClient(previous)
  }
})
