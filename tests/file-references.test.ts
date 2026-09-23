import {test,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'

const bytes=(value:string)=>new TextEncoder().encode(value)
const text=(value:Uint8Array)=>new TextDecoder().decode(value)

test('open references follow file identity through rename and replacement',()=>{
  const fs=new WorkspaceFiles({'/a':'first','/b':'second'})
  const a=fs.acquireFileSync('/a'),b=fs.acquireFileSync('/b')
  fs.renameSync('/a','/b')
  expect(text(a.read(0,100))).toBe('first')
  expect(text(b.read(0,100))).toBe('second')
  a.write(0,bytes('F'))
  expect(text(fs.readFileSync('/b'))).toBe('First')
  b.write(0,bytes('S'))
  expect(text(b.read(0,100))).toBe('Second')
  expect(fs.byteLength).toBe(11)
  b.close();expect(fs.byteLength).toBe(5)
  a.close()
})

test('unlink keeps live bytes charged until the last reference closes',()=>{
  const fs=new WorkspaceFiles({'/a':'1234'},6)
  const first=fs.acquireFileSync('/a'),second=fs.acquireFileSync('/a')
  expect(fs.byteLength).toBe(4)
  fs.unlinkSync('/a');first.close()
  expect(fs.byteLength).toBe(4)
  expect(()=>fs.writeFileSync('/a',bytes('new'))).toThrow('ENOSPC')
  expect(text(second.read(0,10))).toBe('1234')
  second.close();second.close()
  expect(fs.byteLength).toBe(0)
  fs.writeFileSync('/a',bytes('new'))
  expect(()=>second.stat()).toThrow('EBADF')
})

test('orphaned open files count against file limits for every creator',()=>{
  const fs=new WorkspaceFiles({'/a':''},100,1),ref=fs.acquireFileSync('/a')
  fs.unlinkSync('/a')
  expect(()=>fs.writeFileSync('/b',bytes(''))).toThrow('ENOSPC')
  expect(()=>fs.mkdirSync('/dir')).toThrow('ENOSPC')
  expect(()=>fs.symlinkSync('a','/link')).toThrow('ENOSPC')
  expect(()=>fs.replace({version:1,files:{'/b':bytes('')}})).toThrow('ENOSPC')
  ref.close();fs.mkdirSync('/dir')
})

test('path writes and patches update the file seen by existing references',async()=>{
  const fs=new WorkspaceFiles({'/a':'before','/other':'untouched'})
  const ref=fs.acquireFileSync('/a'),other=fs.acquireFileSync('/other')
  fs.writeFileSync('/a',bytes('middle'))
  expect(text(ref.read(0,100))).toBe('middle')
  await fs.patch('/a','middle','after')
  expect(text(ref.read(0,100))).toBe('after')
  other.write(0,bytes('U'))
  expect(text(fs.readFileSync('/other'))).toBe('Untouched')
  ref.close();other.close()
})

test('snapshot replacement preserves old references and rejects quota overflow atomically',()=>{
  const fs=new WorkspaceFiles({'/a':'old'},6),ref=fs.acquireFileSync('/a')
  const before=fs.snapshot(),revision=fs.revision
  expect(()=>fs.replace({version:1,files:{'/a':bytes('long')}})).toThrow('ENOSPC')
  expect(fs.snapshot()).toEqual(before);expect(fs.revision).toBe(revision)
  fs.replace({version:1,files:{'/a':bytes('new')}})
  expect(text(ref.read(0,10))).toBe('old')
  expect(text(fs.readFileSync('/a'))).toBe('new')
  expect(fs.byteLength).toBe(6)
  ref.close();expect(fs.byteLength).toBe(3)
})

test('reference reads copy data, writes fill holes, and truncation is quota checked',()=>{
  const fs=new WorkspaceFiles({'/a':'ab'},8),ref=fs.acquireFileSync('/a')
  const read=ref.read(0,2);read[0]=0
  expect(text(ref.read(0,2))).toBe('ab')
  const write=bytes('z');ref.write(4,write);write[0]=0
  expect([...ref.read(0,10)]).toEqual([97,98,0,0,122])
  expect(ref.read(100,10).length).toBe(0)
  ref.truncate(7);expect(ref.stat().size).toBe(7)
  const revision=fs.revision
  expect(()=>ref.truncate(9)).toThrow('ENOSPC')
  expect(()=>ref.write(8,bytes('x'))).toThrow('ENOSPC')
  expect(fs.revision).toBe(revision);expect(ref.stat().size).toBe(7)
  ref.truncate(1);expect(text(ref.read(0,10))).toBe('a')
  for(const value of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1]){
    expect(()=>ref.read(value,1)).toThrow('EINVAL')
    expect(()=>ref.write(value,bytes('x'))).toThrow('EINVAL')
    expect(()=>ref.truncate(value)).toThrow('EINVAL')
  }
  ref.close()
})

test('reference events use the current name and workspace shutdown invalidates references',()=>{
  const fs=new WorkspaceFiles({'/tree/a':'a'}),ref=fs.acquireFileSync('/tree/a')
  fs.renameSync('/tree','/moved')
  const events:unknown[]=[];fs.subscribe(event=>events.push(event))
  ref.write(0,bytes('b'))
  expect(events).toEqual([{path:'/moved/a',eventType:'change'}])
  fs.rmSync('/moved',{recursive:true});events.length=0
  ref.write(0,bytes('c'));expect(events).toEqual([])
  expect(fs.byteLength).toBe(1)
  fs.close();expect(fs.byteLength).toBe(0)
  expect(()=>ref.read(0,1)).toThrow('Workspace is closed')
  ref.close()
})

test('reference acquisition follows links and rejects directories and missing paths',()=>{
  const fs=new WorkspaceFiles({'/dir/a':'value'})
  fs.symlinkSync('dir/a','/link')
  const ref=fs.acquireFileSync('/link')
  fs.unlinkSync('/link');expect(text(ref.read(0,100))).toBe('value')
  expect(()=>fs.acquireFileSync('/dir')).toThrow('EISDIR')
  expect(()=>fs.acquireFileSync('/missing')).toThrow('ENOENT')
  ref.close()
})
