import {test,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import {WorkspaceFileSessions} from '../src/sandbox/workspace-file-sessions'
import {CompilerWorkspace,createCompilerFilesystem} from '../src/compiler/compiler-workspace'

function setup(writable=true){
  const files=new WorkspaceFiles({'/tmp/existing':'old'}),sessions=new WorkspaceFileSessions(files)
  const workspace=new CompilerWorkspace(sessions,writable)
  const fs=createCompilerFilesystem((method,args)=>workspace.call(method,args))
  const invoke=(method:string,...args:unknown[])=>new Promise<any>((resolve,reject)=>{
    ;(fs as any)[method](...args,(error:Error|null,value:unknown)=>error?reject(error):resolve(value))
  })
  return {files,sessions,workspace,fs,invoke,close(){workspace.close();sessions.close();files.close()}}
}
const bytes=(value:string)=>new TextEncoder().encode(value)

test('compiler callbacks create, write and positionally read a live temporary file',async()=>{
  const h=setup()
  try{
    const fd=await h.invoke('open','/tmp/compiler.ts',h.fs.constants.O_RDWR|h.fs.constants.O_CREAT,0o600)
    await h.invoke('write',fd,bytes('_hello_'),1,5,null)
    await h.invoke('write',fd,bytes('A'),0,1,1)
    const output=new Uint8Array(7)
    expect(await h.invoke('read',fd,output,1,5,0)).toBe(5)
    expect(output).toEqual(new Uint8Array([0,...bytes('hAllo'),0]))
    // Positioned operations leave the sequential cursor at the end of the first write.
    await h.invoke('write',fd,bytes('!'),0,1,null)
    expect(h.files.readFileSync('/tmp/compiler.ts')).toEqual(bytes('hAllo!'))
    expect(await h.invoke('fstat',fd)).toMatchObject({size:6,mode:0o100600})
    expect((await h.invoke('stat','/tmp')).isDirectory()).toBe(true)
    expect((await h.invoke('lstat','/tmp/compiler.ts')).isFile()).toBe(true)
    expect(await h.invoke('readdir','/tmp')).toContain('compiler.ts')
    await h.invoke('close',fd)
    expect(h.sessions.descriptors).toBe(0)
  }finally{h.close()}
})

test('compiler sees editor changes through live workspace and closes its descriptor lease',async()=>{
  const h=setup()
  try{
    h.files.writeFileSync('/tmp/existing',bytes('edited'))
    const fd=await h.invoke('open','/tmp/existing',0,0)
    const output=new Uint8Array(6)
    await h.invoke('read',fd,output,0,6,null)
    expect(output).toEqual(bytes('edited'))
    expect(h.sessions.descriptors).toBe(1)
    h.workspace.close();h.workspace.close()
    expect(h.sessions.descriptors).toBe(0);expect(h.sessions.size).toBe(0)
    await expect(h.invoke('fstat',fd)).rejects.toMatchObject({code:'EBADF'})
    expect(h.files.readFileSync('/tmp/existing')).toEqual(bytes('edited'))
  }finally{h.close()}
})

test('compiler filesystem retains read-only authority and rejects unsupported operations',async()=>{
  const h=setup(false)
  try{
    await expect(h.invoke('open','/tmp/existing',h.fs.constants.O_WRONLY|h.fs.constants.O_TRUNC,0o600)).rejects.toMatchObject({code:'EACCES'})
    await expect(h.invoke('unlink','/tmp/existing')).rejects.toMatchObject({code:'ENOSYS'})
    await expect(h.invoke('mkdir','/tmp/output',0o755)).rejects.toMatchObject({code:'EACCES'})
    expect(h.files.readFileSync('/tmp/existing')).toEqual(bytes('old'))
  }finally{h.close()}
})

test('compiler creates output directories with normal mode and parent semantics',async()=>{
  const h=setup()
  try{
    await h.invoke('mkdir','/tmp/output',0o750)
    expect(await h.invoke('stat','/tmp/output')).toMatchObject({kind:'directory',mode:0o40750})
    await expect(h.invoke('mkdir','/tmp/output',0o750)).rejects.toMatchObject({code:'EEXIST'})
    await expect(h.invoke('mkdir','/missing/output',0o750)).rejects.toMatchObject({code:'ENOENT'})
    await expect(h.invoke('mkdir','/tmp/invalid',{})).rejects.toMatchObject({code:'EINVAL'})
  }finally{h.close()}
})

test('compiler writes retain workspace quotas and closing cancels queued filesystem work',async()=>{
  const files=new WorkspaceFiles({'/file':'abc'},4),sessions=new WorkspaceFileSessions(files)
  const workspace=new CompilerWorkspace(sessions,true)
  try{
    const fd=await workspace.call('open',['/file','a'])
    await expect(workspace.call('write',[fd,bytes('de'),null])).rejects.toMatchObject({code:'ENOSPC'})
    expect(files.readFileSync('/file')).toEqual(bytes('abc'))
    const queued=workspace.call('write',[fd,bytes('d'),null])
    workspace.close()
    await expect(queued).rejects.toMatchObject({code:'EBADF'})
    expect(files.readFileSync('/file')).toEqual(bytes('abc'))
    expect(sessions.descriptors).toBe(0)
  }finally{workspace.close();sessions.close();files.close()}
})

test('large compiler buffers use bounded short I/O without losing data',async()=>{
  const h=setup()
  try{
    const source=new Uint8Array(100000).map((_,index)=>index%251)
    const fd=await h.invoke('open','/tmp/large',h.fs.constants.O_RDWR|h.fs.constants.O_CREAT,0o600)
    const first=await h.invoke('write',fd,source,0,source.length,null)
    expect(first).toBe(65536)
    expect(await h.invoke('write',fd,source,first,source.length-first,null)).toBe(source.length-first)
    const output=new Uint8Array(source.length)
    const read=await h.invoke('read',fd,output,0,output.length,0)
    expect(read).toBe(65536)
    expect(await h.invoke('read',fd,output,read,output.length-read,read)).toBe(output.length-read)
    expect(output).toEqual(source)
  }finally{h.close()}
})
