import {describe,it,expect} from 'vitest'
import {Volume,createFsFromVolume} from 'memfs'
import {createWASIFileSystem} from '../src/sandbox/guest-wasi-files.js'

function fixture(){
  const fs=createFsFromVolume(Volume.fromJSON({'/project/input.txt':'hello','/project/dir/child.txt':'child'}))
  const memory=new WebAssembly.Memory({initial:1}),bytes=new Uint8Array(memory.buffer),view=new DataView(memory.buffer)
  const api=createWASIFileSystem(fs,{'/work':'/project'},()=>memory)
  const path=(value:string)=>{const b=new TextEncoder().encode(value);bytes.set(b,100);return b.length}
  const open=(name:string,rights=2n,flags=0)=>{expect(api.imports.path_open(3,1,100,path(name),flags,rights,0n,0,16)).toBe(0);return view.getUint32(16,true)}
  const iov=(value:string)=>{bytes.set(new TextEncoder().encode(value),300);view.setUint32(200,300,true);view.setUint32(204,value.length,true)}
  return {fs,api,bytes,view,path,open,iov}
}
describe('WASI virtual file descriptors',()=>{
  it('masks directory rights from regular file descriptors and clears inheriting rights',()=>{
    const {api,path,view}=fixture()
    const rights=(bits:number[])=>bits.reduce((value,bit)=>value|(1n<<BigInt(bit)),0n)
    const file=rights([1,2,5,6,21,27]),directory=rights([9,10,13,14,15,18,19,21,25,26])
    try{
      expect(api.imports.path_open(3,1,100,path('input.txt'),0,file|directory,file|directory,0,16)).toBe(0)
      const fd=view.getUint32(16,true)
      expect(api.imports.fd_fdstat_get(fd,32)).toBe(0)
      expect(view.getUint8(32)).toBe(4)
      expect(view.getBigUint64(40,true)).toBe(file)
      expect(view.getBigUint64(48,true)).toBe(0n)
      expect(api.imports.fd_close(fd)).toBe(0)
    }finally{api.close()}
  })
  it('accepts NONBLOCK on a regular file while preserving read and seek behavior',()=>{
    const {api,path,view,bytes,iov}=fixture()
    try{
      expect(api.imports.path_open(3,1,100,path('input.txt'),0,2n|4n,0n,4,16)).toBe(0)
      const fd=view.getUint32(16,true)
      expect(api.imports.fd_fdstat_get(fd,32)).toBe(0)
      expect(view.getUint16(34,true)&4).toBe(4)
      expect(view.getBigUint64(40,true)).toBe(2n|4n)
      iov('..');expect(api.imports.fd_read(fd,200,1,16)).toBe(0)
      expect(view.getUint32(16,true)).toBe(2)
      expect(new TextDecoder().decode(bytes.subarray(300,302))).toBe('he')
      expect(api.imports.fd_seek(fd,3n,0,16)).toBe(0)
      expect(view.getBigUint64(16,true)).toBe(3n)
      iov('..');expect(api.imports.fd_read(fd,200,1,16)).toBe(0)
      expect(view.getUint32(16,true)).toBe(2)
      expect(new TextDecoder().decode(bytes.subarray(300,302))).toBe('lo')
      expect(api.imports.fd_close(fd)).toBe(0)
    }finally{api.close()}
  })
  it('polls remaining regular file bytes without moving the offset, including EOF',()=>{
    const {api,open,iov,view}=fixture(),pollRight=1n<<27n
    const fd=open('input.txt',2n|4n|64n|pollRight)
    expect(api.poll(fd,1)).toEqual({error:0,nbytes:5n,flags:0})
    expect(api.poll(fd,1)).toEqual({error:0,nbytes:5n,flags:0})
    expect(api.poll(fd,2)).toEqual({error:0,nbytes:0n,flags:0})
    iov('..');expect(api.imports.fd_read(fd,200,1,16)).toBe(0)
    expect(view.getUint32(16,true)).toBe(2)
    expect(api.poll(fd,1)).toEqual({error:0,nbytes:3n,flags:0})
    expect(api.imports.fd_seek(fd,5n,0,16)).toBe(0)
    expect(api.poll(fd,1)).toEqual({error:0,nbytes:0n,flags:0})
    expect(api.imports.fd_seek(fd,10n,0,16)).toBe(0)
    expect(api.poll(fd,1)).toEqual({error:0,nbytes:0n,flags:0})
    api.close()
  })
  it('checks polling and operation rights and reports descriptor errors',()=>{
    const {api,open,view}=fixture(),pollRight=1n<<27n
    const noPoll=open('input.txt',2n|64n),readOnly=open('input.txt',2n|pollRight),writeOnly=open('input.txt',64n|pollRight)
    expect(api.poll(noPoll,1)).toEqual({error:76})
    expect(api.poll(noPoll,2)).toEqual({error:76})
    expect(api.poll(readOnly,2)).toEqual({error:76})
    expect(api.poll(writeOnly,1)).toEqual({error:76})
    expect(api.poll(writeOnly,2)).toEqual({error:0,nbytes:0n,flags:0})
    expect(api.imports.fd_fdstat_get(3,32)).toBe(0)
    expect(view.getBigUint64(48,true)&pollRight).toBe(pollRight)
    expect(api.imports.fd_fdstat_get(readOnly,32)).toBe(0)
    expect(view.getBigUint64(40,true)&pollRight).toBe(pollRight)
    expect(api.poll(3,1)).toEqual({error:58})
    expect(api.poll(readOnly,0)).toEqual({error:28})
    expect(api.poll(999,1)).toEqual({error:8})
    expect(api.imports.fd_close(readOnly)).toBe(0)
    expect(api.poll(readOnly,1)).toEqual({error:8})
    api.close()
    expect(api.poll(writeOnly,2)).toEqual({error:8})
  })
  it('reports preopens and descriptor ABI rights',()=>{const {api,view,bytes}=fixture();expect(api.imports.fd_prestat_get(3,16)).toBe(0);expect(view.getUint32(20,true)).toBe(5);expect(api.imports.fd_prestat_dir_name(3,100,5)).toBe(0);expect(new TextDecoder().decode(bytes.subarray(100,105))).toBe('/work');expect(api.imports.fd_fdstat_get(3,32)).toBe(0);expect(view.getUint8(32)).toBe(3);expect(view.getBigUint64(40,true)&8192n).toBe(8192n)})
  it('reads, seeks, writes and closes an ordinary file',()=>{const {api,open,iov,view,bytes,fs}=fixture();const fd=open('input.txt',2n|4n|32n|64n|2097152n);iov('.....');expect(api.imports.fd_read(fd,200,1,16)).toBe(0);expect(view.getUint32(16,true)).toBe(5);expect(new TextDecoder().decode(bytes.subarray(300,305))).toBe('hello');expect(api.imports.fd_seek(fd,0n,0,16)).toBe(0);iov('world');expect(api.imports.fd_write(fd,200,1,16)).toBe(0);expect(fs.readFileSync('/project/input.txt','utf8')).toBe('world');expect(api.imports.fd_filestat_get(fd,400)).toBe(0);expect(view.getBigUint64(432,true)).toBe(5n);expect(api.imports.fd_close(fd)).toBe(0);expect(api.imports.fd_read(fd,200,1,16)).toBe(8)})
  it('creates a file and directory then removes both',()=>{const {api,path,open,fs}=fixture();expect(api.imports.path_create_directory(3,100,path('new'))).toBe(0);const fd=open('new/output.txt',64n,1);expect(api.imports.fd_close(fd)).toBe(0);expect(fs.existsSync('/project/new/output.txt')).toBe(true);expect(api.imports.path_unlink_file(3,100,path('new/output.txt'))).toBe(0);expect(api.imports.path_remove_directory(3,100,path('new'))).toBe(0)})
  it('emits directory entry records and accepts continuation cookies',()=>{const {api,bytes,view}=fixture();expect(api.imports.fd_readdir(3,500,128,0n,16)).toBe(0);const length=view.getUint32(516,true);expect(view.getBigUint64(500,true)).toBe(1n);const first=new TextDecoder().decode(bytes.subarray(524,524+length));expect(['dir','input.txt']).toContain(first);expect(api.imports.fd_readdir(3,500,128,1n,16)).toBe(0);expect(view.getBigUint64(500,true)).toBe(2n)})
  it('maps ordinary errors and does not claim unsupported flag support',()=>{const {api,path,open,iov}=fixture();expect(api.imports.path_open(3,1,100,path('missing'),0,2n,0n,0,16)).toBe(44);const fd=open('input.txt');iov('x');expect(api.imports.fd_write(fd,200,1,16)).toBe(76);expect(api.imports.path_open(3,1,100,path('input.txt'),0,2n,0n,2,16)).toBe(58);expect(api.imports.fd_prestat_get(0,16)).toBe(8)})
  it('reads a normal relative symbolic link and follows it for file access',()=>{const {api,fs,path,bytes,view,open}=fixture();fs.symlinkSync('input.txt','/project/link');expect(api.imports.path_readlink(3,100,path('link'),300,32,16)).toBe(0);expect(new TextDecoder().decode(bytes.subarray(300,300+view.getUint32(16,true)))).toBe('input.txt');expect(api.imports.path_filestat_get(3,0,100,path('link'),400)).toBe(0);expect(view.getUint8(416)).toBe(7);expect(api.imports.path_filestat_get(3,1,100,path('link'),400)).toBe(0);expect(view.getUint8(416)).toBe(4);expect(api.imports.fd_close(open('link'))).toBe(0)})
  it('appends at end even after a seek and releases open handles',()=>{const {api,path,view,iov,fs}=fixture();expect(api.imports.path_open(3,1,100,path('input.txt'),0,64n|4n,0n,1,16)).toBe(0);const fd=view.getUint32(16,true);expect(api.imports.fd_seek(fd,0n,0,16)).toBe(0);iov('!');expect(api.imports.fd_write(fd,200,1,16)).toBe(0);expect(fs.readFileSync('/project/input.txt','utf8')).toBe('hello!');api.close();expect(api.imports.fd_close(fd)).toBe(8)})
})
