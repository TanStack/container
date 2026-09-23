import {expect,test,vi} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'

const bytes=(text:string)=>new TextEncoder().encode(text)

test('writes account for resized nodes once while handles share their identity',async()=>{
  const fs=new WorkspaceFiles({'/file':'ab'},8,2)
  const first=fs.acquireFileSync('/file'),second=fs.acquireFileSync('/file')
  fs.writeFileSync('/file',bytes('abcd'))
  expect(fs.byteLength).toBe(4)
  expect(first.stat().ino).toBe(fs.statSync('/file').ino)
  second.write(6,bytes('x'));expect(fs.byteLength).toBe(7)
  first.truncate(3);expect(fs.byteLength).toBe(3)
  await fs.patch('/file','abc','xy');expect(fs.byteLength).toBe(2)
  first.close();second.close();expect(fs.byteLength).toBe(2)
  fs.writeFileSync('/other',bytes('123456'));expect(fs.byteLength).toBe(8)
  expect(()=>fs.writeFileSync('/third',new Uint8Array())).toThrow('ENOSPC')
  fs.close()
})

test('replacing a snapshot keeps each old retained node charged until its final close',()=>{
  const fs=new WorkspaceFiles({'/file':'old'},12,3)
  const first=fs.acquireFileSync('/file'),second=fs.acquireFileSync('/file')
  fs.replace({version:1,files:{'/file':bytes('new')}})
  const third=fs.acquireFileSync('/file')
  fs.replace({version:1,files:{'/file':bytes('last')}})
  expect(fs.byteLength).toBe(10)
  expect(()=>fs.mkdirSync('/extra')).toThrow('ENOSPC')
  first.close();expect(fs.byteLength).toBe(10)
  second.truncate(1);expect(fs.byteLength).toBe(8)
  second.close();expect(fs.byteLength).toBe(7)
  fs.mkdirSync('/extra')
  third.close();expect(fs.byteLength).toBe(4)
  fs.writeFileSync('/empty',new Uint8Array())
  fs.close()
})

test('unlink and recursive removal release names and symlink bytes but retain open nodes',()=>{
  const fs=new WorkspaceFiles({'/tree/file':'123','/tree/nested/file':'45'},100,8)
  fs.symlinkSync('é','/tree/link')
  const first=fs.acquireFileSync('/tree/file'),second=fs.acquireFileSync('/tree/file')
  expect(fs.byteLength).toBe(7)
  fs.unlinkSync('/tree/link');expect(fs.byteLength).toBe(5)
  fs.symlinkSync('éé','/tree/nested/link');expect(fs.byteLength).toBe(9)
  fs.rmSync('/tree',{recursive:true});expect(fs.byteLength).toBe(3)
  first.close();expect(fs.byteLength).toBe(3)
  second.write(3,bytes('456'));expect(fs.byteLength).toBe(6)
  second.close();second.close();expect(fs.byteLength).toBe(0)
  for(let index=0;index<8;index++)fs.writeFileSync('/'+index,new Uint8Array())
  expect(()=>fs.mkdirSync('/extra')).toThrow('ENOSPC')
  fs.close()
})

test('renames release overwritten files and links without charging moved nodes twice',()=>{
  const fs=new WorkspaceFiles({'/first':'123','/second':'4567'},100,3)
  fs.renameSync('/first','/second');expect(fs.byteLength).toBe(3)
  fs.symlinkSync('éé','/link');expect(fs.byteLength).toBe(7)
  fs.renameSync('/second','/link');expect(fs.byteLength).toBe(3)
  const retained=fs.acquireFileSync('/link')
  fs.symlinkSync('é','/source');expect(fs.byteLength).toBe(5)
  fs.renameSync('/source','/link');expect(fs.byteLength).toBe(5)
  retained.close();expect(fs.byteLength).toBe(2)
  fs.symlinkSync('long','/replacement');expect(fs.byteLength).toBe(6)
  fs.renameSync('/replacement','/link');expect(fs.byteLength).toBe(4)
  fs.renameSync('/link','/link');expect(fs.byteLength).toBe(4)
  fs.unlinkSync('/link');expect(fs.byteLength).toBe(0)
  fs.close()
})

test('directory moves and restores preserve parent checks and accounting before events',()=>{
  const fs=new WorkspaceFiles({'/tree/nested/file':'abc'},100,10)
  fs.symlinkSync('nested/file','/tree/link')
  fs.mkdirSync('/destination')
  const observed:number[]=[]
  fs.subscribe(()=>observed.push(fs.byteLength))
  fs.renameSync('/tree','/destination')
  expect(fs.byteLength).toBe(14)
  expect(observed).toEqual([14,14])
  expect(()=>fs.writeFileSync('/destination',bytes('x'))).toThrow('EISDIR')
  expect(()=>fs.writeFileSync('/destination/nested/file/child',bytes('x'))).toThrow('ENOTDIR')
  const saved=fs.snapshot()
  fs.replace({version:1,files:{'/other':bytes('x')}})
  expect(fs.byteLength).toBe(1)
  fs.replace(saved);expect(fs.byteLength).toBe(14)
  expect(()=>fs.writeFileSync('/destination/nested',bytes('x'))).toThrow('EISDIR')
  fs.rmSync('/destination/nested',{recursive:true});expect(fs.byteLength).toBe(11)
  fs.unlinkSync('/destination/link');expect(fs.byteLength).toBe(0)
  fs.rmdirSync('/destination')
  fs.close()
})

test('failed mutations leave byte and file quotas, snapshots, revisions, and events unchanged',()=>{
  const fs=new WorkspaceFiles({'/file':'abc'},5,2),ref=fs.acquireFileSync('/file')
  const events:unknown[]=[]
  fs.subscribe(event=>events.push(event))
  const before=fs.snapshot(),revision=fs.revision
  for(const attempt of [
    ()=>fs.writeFileSync('/file',bytes('123456')),
    ()=>fs.writeFileSync('/new/child',bytes('x')),
    ()=>fs.symlinkSync('éé','/link'),
    ()=>ref.write(5,bytes('x')),
    ()=>ref.truncate(6),
    ()=>fs.replace({version:1,files:{'/new':bytes('abc')}}),
    ()=>fs.replace({version:2,files:{'/directory':bytes('')},directories:['/directory']}),
    ()=>fs.renameSync('/file','/missing/file'),
  ]){
    expect(attempt).toThrow()
    expect(fs.byteLength).toBe(3)
    expect(fs.snapshot()).toEqual(before)
    expect(fs.revision).toBe(revision)
    expect(events).toEqual([])
  }
  fs.symlinkSync('é','/link');expect(fs.byteLength).toBe(5)
  expect(()=>fs.mkdirSync('/full')).toThrow('ENOSPC')
  ref.close();fs.close()
})

test('workspace shutdown and repeated late handle closes do not make accounting negative',()=>{
  const fs=new WorkspaceFiles({'/file':'abc'})
  const first=fs.acquireFileSync('/file'),second=fs.acquireFileSync('/file')
  fs.unlinkSync('/file')
  fs.close();expect(fs.byteLength).toBe(0)
  first.close();second.close();first.close();fs.close()
  expect(fs.byteLength).toBe(0)
})

test('file creation and quota reads do not enumerate existing file maps',()=>{
  const fs=new WorkspaceFiles()
  for(let index=0;index<1000;index++)fs.writeFileSync('/package/'+index,bytes('x'))
  const spies=[vi.spyOn(Map.prototype,'keys'),vi.spyOn(Map.prototype,'values'),vi.spyOn(Map.prototype,Symbol.iterator)]
  let calls:number[]
  try{
    for(let index=1000;index<1100;index++)fs.writeFileSync('/package/'+index,bytes('x'))
    void fs.byteLength
    calls=spies.map(spy=>spy.mock.calls.length)
  }finally{for(const spy of spies)spy.mockRestore()}
  expect(calls!).toEqual([0,0,0])
  expect(fs.byteLength).toBe(1100)
  fs.close()
})
