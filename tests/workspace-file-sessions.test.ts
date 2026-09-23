import {test,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import {WorkspaceFileSessions} from '../src/sandbox/workspace-file-sessions'

test('file sessions share live workspace data but not descriptor authority',()=>{
  const files=new WorkspaceFiles({'/input':'old'}),sessions=new WorkspaceFileSessions(files)
  const a=sessions.open(true),b=sessions.open(false)
  try{
    const fd=a.call('open',['/input','r+']) as number
    expect(()=>b.call('read',[fd,3])).toThrow('EBADF')
    a.call('write',[fd,new TextEncoder().encode('new')])
    expect(new TextDecoder().decode(files.readFileSync('/input'))).toBe('new')
    const other=b.call('open',['/input','r']) as number
    expect(new TextDecoder().decode(b.call('read',[other,3]) as Uint8Array)).toBe('new')
    a.close();a.close()
    expect(()=>a.call('stat',['/input'])).toThrow('closed')
    expect(b.call('fstat',[other])).toMatchObject({size:3})
    expect(sessions.descriptors).toBe(1)
  }finally{sessions.close();files.close()}
  expect(sessions.size).toBe(0);expect(sessions.descriptors).toBe(0)
})

test('read-only sessions cannot create or truncate workspace files',()=>{
  const files=new WorkspaceFiles({'/input':'kept'}),sessions=new WorkspaceFileSessions(files),session=sessions.open(false)
  try{
    expect(()=>session.call('open',['/new','w'])).toThrow('read-only')
    expect(()=>session.call('open',['/input','w'])).toThrow('read-only')
    expect(files.existsSync('/new')).toBe(false)
    expect(new TextDecoder().decode(files.readFileSync('/input'))).toBe('kept')
  }finally{sessions.close();files.close()}
})

test('session closure preserves workspace files and revokes old handles',()=>{
  const files=new WorkspaceFiles(),sessions=new WorkspaceFileSessions(files),a=sessions.open(true)
  const fd=a.call('open',['/saved','w']) as number
  a.call('write',[fd,new Uint8Array([0,255,128])]);a.close()
  const b=sessions.open(true)
  try{
    expect(files.readFileSync('/saved')).toEqual(new Uint8Array([0,255,128]))
    expect(()=>b.call('close',[fd])).toThrow('EBADF')
    const fresh=b.call('open',['/saved','r']) as number
    expect(fresh).not.toBe(fd)
    expect(()=>b.call('read',[fresh,65537])).toThrow('transport limit')
    expect(()=>b.call('write',[fresh,new Uint8Array(65537)])).toThrow('transport limit')
  }finally{sessions.close();files.close()}
  expect(()=>sessions.open(true)).toThrow('closed')
})

test('session count is bounded and a closed slot can be reused',()=>{
  const files=new WorkspaceFiles(),sessions=new WorkspaceFileSessions(files)
  try{
    const leases=Array.from({length:8},()=>sessions.open(false))
    expect(()=>sessions.open(false)).toThrow('limit')
    leases[0]!.close();sessions.open(false)
    expect(sessions.size).toBe(8)
  }finally{sessions.close();files.close()}
})

test('positioned I/O preserves the sequential cursor and accepts position zero',()=>{
  const files=new WorkspaceFiles({'/input':'abcdef'}),sessions=new WorkspaceFileSessions(files),session=sessions.open(true)
  const decode=(bytes:unknown)=>new TextDecoder().decode(bytes as Uint8Array)
  const encode=(text:string)=>new TextEncoder().encode(text)
  try{
    const fd=session.call('open',['/input','r+']) as number
    expect(decode(session.call('read',[fd,2]))).toBe('ab')
    expect(decode(session.call('read',[fd,2,4]))).toBe('ef')
    expect(decode(session.call('read',[fd,1,null]))).toBe('c')
    expect(session.call('write',[fd,encode('XY'),0])).toBe(2)
    expect(decode(session.call('read',[fd,1]))).toBe('d')
    expect(session.call('write',[fd,encode('Z'),null])).toBe(1)
    expect(decode(session.call('read',[fd,1,0]))).toBe('X')
    expect(decode(session.call('read',[fd,1]))).toBe('f')
    expect(decode(files.readFileSync('/input'))).toBe('XYcdZf')
  }finally{sessions.close();files.close()}
})

test('invalid positions fail without moving the cursor or changing file contents',()=>{
  const files=new WorkspaceFiles({'/input':'abc'}),sessions=new WorkspaceFileSessions(files),session=sessions.open(true)
  try{
    const fd=session.call('open',['/input','r+']) as number
    for(const value of [-1,0.5,NaN,Infinity,'0',{},Number.MAX_SAFE_INTEGER+1]){
      expect(()=>session.call('read',[fd,1,value])).toThrow('EINVAL')
      expect(()=>session.call('write',[fd,new Uint8Array([120]),value])).toThrow('EINVAL')
    }
    expect(new TextDecoder().decode(session.call('read',[fd,1]) as Uint8Array)).toBe('a')
    expect(new TextDecoder().decode(files.readFileSync('/input'))).toBe('abc')
  }finally{sessions.close();files.close()}
})
