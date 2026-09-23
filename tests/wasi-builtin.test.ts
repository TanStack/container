import {expect,test} from 'vitest'
import {WASI as NativeWASI} from 'node:wasi'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
// @ts-expect-error The guest source intentionally has no host declaration file.
import {WASI as GuestWASI} from '../src/sandbox/guest-wasi.js'

const uleb=(value:number)=>{const bytes=[];do{let byte=value&127;value>>>=7;if(value)byte|=128;bytes.push(byte)}while(value);return bytes}
const string=(value:string)=>{const bytes=[...new TextEncoder().encode(value)];return [...uleb(bytes.length),...bytes]}
const section=(id:number,payload:number[])=>[id,...uleb(payload.length),...payload]
const header=[0,97,115,109,1,0,0,0]
const memory=section(5,[1,0,1])

function reactor(){
  const types=section(1,[1,0x60,0,0]),functions=section(3,[1,0])
  const exports=section(7,[2,...string('_initialize'),0,0,...string('memory'),2,0])
  const code=section(10,[1,2,0,0x0b])
  return new Uint8Array([...header,...types,...functions,...memory,...exports,...code])
}

function exitProgram(){
  const types=section(1,[2,0x60,1,0x7f,0,0x60,0,0])
  const imports=section(2,[1,...string('wasi_snapshot_preview1'),...string('proc_exit'),0,0])
  const functions=section(3,[1,1]),exports=section(7,[2,...string('_start'),0,1,...string('memory'),2,0])
  const code=section(10,[1,6,0,0x41,7,0x10,0,0x0b])
  return new Uint8Array([...header,...types,...imports,...functions,...memory,...exports,...code])
}

test('zero-delay monotonic clock polling matches native WASI',()=>{
  function run(Constructor:typeof GuestWASI){
    const wasi=new Constructor({version:'preview1',returnOnExit:true})
    const instance=new WebAssembly.Instance(new WebAssembly.Module(reactor()),wasi.getImportObject())
    wasi.initialize(instance)
    const view=new DataView((instance.exports.memory as WebAssembly.Memory).buffer)
    // preview1 subscription: userdata, tag, then the aligned clock payload.
    view.setBigUint64(64,42n,true)
    view.setUint8(72,0)
    view.setUint32(80,1,true)
    view.setBigUint64(88,0n,true)
    view.setBigUint64(96,0n,true)
    view.setUint16(104,0,true)
    expect(typeof wasi.wasiImport.poll_oneoff).toBe('function')
    const errno=wasi.wasiImport.poll_oneoff(64,128,1,192)
    return {errno,count:view.getUint32(192,true),userdata:view.getBigUint64(128,true),eventError:view.getUint16(136,true),type:view.getUint8(138)}
  }
  const expected=run(NativeWASI)
  expect(expected).toEqual({errno:0,count:1,userdata:42n,eventError:0,type:0})
  expect(run(GuestWASI)).toEqual(expected)
})

test('preview1 lifecycle and proc_exit match a native controlled WASM fixture',async()=>{
  const native=new NativeWASI({version:'preview1',returnOnExit:true})
  const nativeInstance=await WebAssembly.instantiate(exitProgram(),native.getImportObject() as WebAssembly.Imports)
  expect(native.start(nativeInstance.instance)).toBe(7)
  const guest=new GuestWASI({version:'preview1',returnOnExit:true})
  expect(guest.getImportObject().wasi_snapshot_preview1).toBe(guest.wasiImport)
  const guestInstance=await WebAssembly.instantiate(exitProgram(),guest.getImportObject())
  expect(guest.start(guestInstance.instance)).toBe(7)
})

test('args, environment, clocks, entropy and fd_write use exported WASM memory',async()=>{
  const wasi=new GuestWASI({version:'preview1',args:['tool','--check'],env:{MODE:'test'},returnOnExit:true})
  const instance=(await WebAssembly.instantiate(reactor(),wasi.getImportObject())).instance
  wasi.initialize(instance)
  const memory=instance.exports.memory as WebAssembly.Memory,view=new DataView(memory.buffer),bytes=new Uint8Array(memory.buffer)
  expect(wasi.wasiImport.args_sizes_get(0,4)).toBe(0)
  expect([view.getUint32(0,true),view.getUint32(4,true)]).toEqual([2,13])
  expect(wasi.wasiImport.args_get(8,32)).toBe(0)
  expect(new TextDecoder().decode(bytes.subarray(32,45))).toBe('tool\0--check\0')
  expect(wasi.wasiImport.environ_sizes_get(64,68)).toBe(0)
  expect([view.getUint32(64,true),view.getUint32(68,true)]).toEqual([1,10])
  expect(wasi.wasiImport.environ_get(72,80)).toBe(0)
  expect(new TextDecoder().decode(bytes.subarray(80,90))).toBe('MODE=test\0')
  expect(wasi.wasiImport.clock_time_get(0,0n,96)).toBe(0)
  expect(view.getBigUint64(96,true)).toBeGreaterThan(0n)
  bytes.fill(0,112,144);expect(wasi.wasiImport.random_get(112,32)).toBe(0)
  expect(bytes.subarray(112,144).some(value=>value!==0)).toBe(true)
  bytes.set(new TextEncoder().encode('wasi output'),160);view.setUint32(152,160,true);view.setUint32(156,11,true)
  const chunks:Uint8Array[]=[]
  const write=process.stdout.write
  process.stdout.write=((chunk:Uint8Array)=>{chunks.push(new Uint8Array(chunk));return true}) as typeof process.stdout.write
  try{expect(wasi.wasiImport.fd_write(1,152,1,148)).toBe(0)}finally{process.stdout.write=write}
  expect(view.getUint32(148,true)).toBe(11)
  expect(new TextDecoder().decode(chunks[0])).toBe('wasi output')
})

test('preopened file reads, writes and end-relative seek match native WASI',()=>{
  function run(Constructor:typeof GuestWASI){
    const directory=mkdtempSync(join(tmpdir(),'sandbox-wasi-files-'))
    writeFileSync(join(directory,'input.txt'),'hello WASI')
    const wasi=new Constructor({version:'preview1',preopens:{'/data':directory},returnOnExit:true})
    const instance=new WebAssembly.Instance(new WebAssembly.Module(reactor()),wasi.getImportObject())
    wasi.initialize(instance)
    const memory=instance.exports.memory as WebAssembly.Memory,view=new DataView(memory.buffer),bytes=new Uint8Array(memory.buffer)
    const api=wasi.wasiImport,codes:number[]=[]
    codes.push(api.fd_prestat_get(3,0),api.fd_prestat_dir_name(3,8,5))
    const preopen={type:view.getUint8(0),length:view.getUint32(4,true),name:new TextDecoder().decode(bytes.subarray(8,13))}
    const path=(name:string)=>{const data=new TextEncoder().encode(name);bytes.set(data,128);return data.length}
    const readRights=2n|4n|32n|2097152n
    codes.push(api.path_open(3,1,128,path('input.txt'),0,readRights,0n,0,64))
    const input=view.getUint32(64,true)
    view.setUint32(80,256,true);view.setUint32(84,64,true)
    codes.push(api.fd_read(input,80,1,88))
    const text=new TextDecoder().decode(bytes.subarray(256,256+view.getUint32(88,true)))
    codes.push(api.fd_seek(input,-2n,2,96),api.fd_read(input,80,1,88))
    const tail=new TextDecoder().decode(bytes.subarray(256,256+view.getUint32(88,true)))
    const offset=Number(view.getBigUint64(96,true))
    codes.push(api.fd_close(input))
    codes.push(api.path_open(3,1,128,path('output.txt'),1|8,64n|2097152n,0n,0,64))
    const output=view.getUint32(64,true)
    bytes.set(new TextEncoder().encode('saved'),256);view.setUint32(84,5,true)
    codes.push(api.fd_write(output,80,1,88),api.fd_filestat_get(output,512),api.fd_close(output))
    const stat={type:view.getUint8(528),size:Number(view.getBigUint64(544,true))}
    return {codes,preopen,text,tail,offset,stat,written:readFileSync(join(directory,'output.txt'),'utf8')}
  }
  const expected=run(NativeWASI)
  expect(expected.codes.every(code=>code===0)).toBe(true)
  expect(run(GuestWASI)).toEqual(expected)
})

test('regular-file poll reports unread bytes and EOF readiness',()=>{
  function run(Constructor:typeof GuestWASI){
    const directory=mkdtempSync(join(tmpdir(),'sandbox-wasi-poll-'))
    writeFileSync(join(directory,'input.txt'),'hello WASI')
    const wasi=new Constructor({version:'preview1',preopens:{'/data':directory},returnOnExit:true})
    const instance=new WebAssembly.Instance(new WebAssembly.Module(reactor()),wasi.getImportObject())
    wasi.initialize(instance)
    const view=new DataView((instance.exports.memory as WebAssembly.Memory).buffer),bytes=new Uint8Array(view.buffer),api=wasi.wasiImport
    const name=new TextEncoder().encode('input.txt');bytes.set(name,128)
    const codes=[api.path_open(3,1,128,name.length,0,2n|4n|(1n<<27n),0n,0,64)]
    const fd=view.getUint32(64,true)
    const poll=(userdata:bigint)=>{
      view.setBigUint64(256,userdata,true);view.setUint8(264,1);view.setUint32(272,fd,true)
      codes.push(api.poll_oneoff(256,320,1,384))
      return {count:view.getUint32(384,true),userdata:view.getBigUint64(320,true),error:view.getUint16(328,true),type:view.getUint8(330),nbytes:view.getBigUint64(336,true),flags:view.getUint16(344,true)}
    }
    const unread=poll(41n)
    view.setUint32(80,512,true);view.setUint32(84,3,true)
    codes.push(api.fd_read(fd,80,1,88))
    const read=view.getUint32(88,true),remaining=poll(42n)
    codes.push(api.fd_seek(fd,0n,2,96))
    const eof=poll(43n)
    codes.push(api.fd_close(fd))
    return {codes,read,unread,remaining,eof}
  }
  expect(run(GuestWASI)).toEqual({
    codes:[0,0,0,0,0,0,0],read:3,
    unread:{count:1,userdata:41n,error:0,type:1,nbytes:10n,flags:0},
    remaining:{count:1,userdata:42n,error:0,type:1,nbytes:7n,flags:0},
    eof:{count:1,userdata:43n,error:0,type:1,nbytes:0n,flags:0},
  })
})
