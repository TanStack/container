import {expect,it} from 'vitest'
import {Volume} from 'memfs'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'

it('removes trees only when requested and preserves unrelated files',()=>{
  const volume=Volume.fromJSON({'/app/tree/nested/file.txt':'value','/app/keep.txt':'keep'})
  const session=new NativeTerminalFileSession(volume)
  try{
    expect(()=>session.call('rm',['/app/tree',{recursive:false,force:false}])).toThrow()
    expect(volume.readFileSync('/app/tree/nested/file.txt','utf8')).toBe('value')
    expect(()=>session.call('rm',['/app/missing',{recursive:false,force:false}])).toThrow('ENOENT')
    session.call('rm',['/app/missing',{recursive:false,force:true}])
    expect(()=>session.call('rm',['/app/tree',{recursive:'yes',force:false}])).toThrow('Invalid remove options')
    expect(()=>session.call('rm',['/outside',{recursive:true,force:true}])).toThrow('Cannot leave')
    session.call('rm',['/app/tree',{recursive:true,force:false}])
    expect(volume.existsSync('/app/tree')).toBe(false)
    expect(volume.readFileSync('/app/keep.txt','utf8')).toBe('keep')
  }finally{session.close()}
})

it('initializes container scratch storage shared by independent file sessions',()=>{
  const volume=Volume.fromJSON({'/app/main.js':''})
  const parent=new NativeTerminalFileSession(volume)
  const child=new NativeTerminalFileSession(volume)
  expect(volume.statSync('/tmp').isDirectory()).toBe(true)
  const descriptor=parent.call('open',['/tmp/module.js',0o1101,0o600]) as number
  parent.call('write',[descriptor,new TextEncoder().encode('42')])
  parent.call('close',[descriptor])
  expect(parent.changedPaths.has('/tmp/module.js')).toBe(true)
  expect(parent.workspaceChangedPaths).toEqual([])
  parent.changedPaths.add('/app/main.js')
  expect(parent.workspaceChangedPaths).toEqual(['/app/main.js'])
  const reader=child.call('open',['/tmp/module.js',0,0]) as number
  expect(new TextDecoder().decode(child.call('read',[reader,2]) as Uint8Array)).toBe('42')
  child.call('close',[reader])
  expect(()=>child.call('stat',['/tmp/../../outside'])).toThrow(expect.objectContaining({code:'ERR_OUTSIDE_CONTAINER_PATH'}))
})

it('flush operations use public descriptor methods and reject unowned descriptors',()=>{
  const volume=Volume.fromJSON({'/app/file.txt':'value'}),session=new NativeTerminalFileSession(volume)
  const descriptor=session.call('open',['/app/file.txt',0,0]) as number
  try{
    expect(session.call('fsync',[descriptor])).toBeUndefined()
    expect(session.call('fdatasync',[descriptor])).toBeUndefined()
    expect(session.changedPaths.size).toBe(0)
    const outsider=volume.openSync('/app/file.txt','r')
    try{expect(()=>session.call('fsync',[outsider])).toThrow('Unknown shell descriptor')}
    finally{volume.closeSync(outsider)}
    session.call('close',[descriptor])
    expect(()=>session.call('fdatasync',[descriptor])).toThrow('Unknown shell descriptor')
  }finally{session.close()}
})

it('reads and writes through the same live volume',()=>{
  const volume=Volume.fromJSON({'/app/read.txt':'hello','/app/write.txt':'old'})
  const session=new NativeTerminalFileSession(volume)
  expect(session.call('access',['/project/read.txt',0])).toBeUndefined()
  expect(()=>session.call('access',['/project/missing.txt',0])).toThrow('ENOENT')
  expect(()=>session.call('access',['/project/read.txt',8])).toThrow('Invalid access mode')
  const input=session.call('open',['/project/read.txt',0,0]) as number
  expect(new TextDecoder().decode(session.call('read',[input,5]) as Uint8Array)).toBe('hello')
  session.call('close',[input])
  const output=session.call('open',['/project/write.txt',0o1001,0o666]) as number
  session.call('write',[output,new TextEncoder().encode('new')])
  session.call('close',[output])
  expect(volume.readFileSync('/app/write.txt','utf8')).toBe('new')
  expect([...session.changedPaths]).toEqual(['/app/write.txt'])
  session.close()
})

it('confines the shell to the project and rejects symlink traversal',()=>{
  const volume=Volume.fromJSON({'/app/file.txt':'x','/outside.txt':'private'})
  volume.symlinkSync('/outside.txt','/app/link')
  const session=new NativeTerminalFileSession(volume)
  expect(()=>session.call('stat',['/project/../outside.txt'])).toThrow('Cannot leave')
  expect(()=>session.call('open',['/project/link',0,0])).toThrow('symbolic link')
  expect(session.call('readlink',['/project/link'])).toBe('/outside.txt')
  expect(session.call('lstat',['/project/link'])).toMatchObject({kind:'symlink'})
  expect(()=>session.call('readlink',['/project/link/child'])).toThrow('symbolic link')
  expect(session.call('readdir',['/project'])).toContain('file.txt')
  session.close()
})

it('returns Node stat fields and recursive mkdir results for live workers',()=>{
  const volume=Volume.fromJSON({'/app/file.txt':'abc'})
  const session=new NativeTerminalFileSession(volume)
  try{
    const stat=session.call('stat',['/project/file.txt']) as {size:number;mode:number;mtimeMs:number;ino:number;kind:string}
    expect(stat).toMatchObject({size:3,kind:'file'})
    expect(Number.isFinite(stat.mtimeMs)).toBe(true)
    expect(Number.isInteger(stat.ino)).toBe(true)
    expect(session.call('mkdir',['/project/new/nested',true])).toBe('/app/new')
    expect(session.call('mkdir',['/project/private/nested',true,0o700])).toBe('/app/private')
    expect(volume.statSync('/app/private/nested').mode&0o777).toBe(0o700)
    expect(()=>session.call('mkdir',['/project/invalid',false,-1])).toThrow('Invalid directory mode')
  }finally{session.close()}
})
it('rejects mkdir through linked parents without creating directories',()=>{
  const volume=Volume.fromJSON({'/app/existing/file.txt':'value'})
  volume.symlinkSync('/app/existing','/app/linked')
  volume.symlinkSync('/app/missing','/app/dangling')
  const session=new NativeTerminalFileSession(volume)
  try{
    for(const path of ['/app/linked/new','/app/dangling/new']){
      expect(()=>session.call('mkdir',[path,true,0o750])).toThrow('symbolic link')
    }
    expect(volume.existsSync('/app/existing/new')).toBe(false)
    expect(volume.existsSync('/app/missing')).toBe(false)
    expect(session.workspaceChangedPaths).toEqual([])
  }finally{session.close()}
})
it('renames files and directory trees without changing bytes or modes',()=>{
  const volume=Volume.fromJSON({'/app/tree/file.bin':'old','/app/replaced.txt':'replace'})
  volume.writeFileSync('/app/tree/file.bin',new Uint8Array([0,128,255]),{mode:0o640})
  volume.chmodSync('/app/tree/file.bin',0o640)
  const session=new NativeTerminalFileSession(volume)
  try{
    session.call('rename',['/app/tree','/app/moved'])
    expect(volume.existsSync('/app/tree')).toBe(false)
    expect([...volume.readFileSync('/app/moved/file.bin') as Uint8Array]).toEqual([0,128,255])
    expect(volume.statSync('/app/moved/file.bin').mode&0o777).toBe(0o640)
    session.call('rename',['/app/moved/file.bin','/app/replaced.txt'])
    expect([...volume.readFileSync('/app/replaced.txt') as Uint8Array]).toEqual([0,128,255])
    expect(()=>session.call('rename',['/app/replaced.txt','/outside.txt'])).toThrow('Cannot leave')
    expect(()=>session.call('rename',['/app/missing','/app/new'])).toThrow('ENOENT')
  }finally{session.close()}
})
