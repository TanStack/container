import {afterEach,test,expect,vi} from 'vitest'
import {statSync} from 'node:fs'
import {WorkspaceFiles} from '../src/sandbox/files'
import source from '../src/sandbox/guest-fs-types.js?raw'
afterEach(()=>vi.restoreAllMocks())
const bytes=(value:string)=>new TextEncoder().encode(value)

test('guest Stats provides the numeric and Date fields present in Node stats',()=>{
  const fs=new WorkspaceFiles({'/file':'data'})
  const {Stats}=new Function('globalThis',source+';return fsTypes')({__webContainerHost:{}})
  const actual=new Stats(fs.statSync('/file')),node=statSync('package.json')
  for(const name of ['dev','ino','mode','nlink','uid','gid','rdev','size','blksize','blocks','atimeMs','mtimeMs','ctimeMs','birthtimeMs']){
    expect(typeof actual[name],name).toBe(typeof (node as any)[name]);expect(Number.isFinite(actual[name]),name).toBe(true)
  }
  for(const name of ['atime','mtime','ctime','birthtime']){
    expect(actual[name]).toBeInstanceOf(Date);expect(actual[name].getTime()).toBe(actual[name+'Ms'])
  }
  fs.close()
})

test('writes and reads update separate timestamps without changing identity or birth time',()=>{
  let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now)
  const fs=new WorkspaceFiles({'/a':'a'}),before=fs.statSync('/a')
  now=2000;fs.writeFileSync('/a',bytes('longer'))
  expect(fs.statSync('/a')).toMatchObject({ino:before.ino,birthtimeMs:1000,atimeMs:1000,mtimeMs:2000,ctimeMs:2000,size:6})
  now=3000;fs.readFileSync('/a')
  expect(fs.statSync('/a')).toMatchObject({atimeMs:3000,mtimeMs:2000,ctimeMs:2000})
  const copy=fs.statSync('/a');copy.ino=99;expect(fs.statSync('/a').ino).toBe(before.ino)
  fs.close()
})

test('rename preserves identity and open unlinked files retain metadata until close',()=>{
  let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now)
  const fs=new WorkspaceFiles({'/a':'a','/b':'b'}),a=fs.acquireFileSync('/a'),b=fs.acquireFileSync('/b')
  const original=a.stat();now=2000;fs.renameSync('/a','/b')
  expect(fs.statSync('/b')).toMatchObject({ino:original.ino,birthtimeMs:1000,mtimeMs:1000,ctimeMs:2000,nlink:1})
  expect(b.stat().nlink).toBe(0)
  now=3000;fs.unlinkSync('/b');expect(a.stat()).toMatchObject({ino:original.ino,nlink:0,ctimeMs:3000})
  now=4000;a.write(0,bytes('updated'));expect(a.stat()).toMatchObject({size:7,mtimeMs:4000,ctimeMs:4000,nlink:0})
  fs.writeFileSync('/b',bytes('new'));expect(fs.statSync('/b').ino).not.toBe(original.ino)
  a.close();b.close();fs.close()
})

test('directory and symlink identities survive subtree rename and parent times track entries',()=>{
  let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now)
  const fs=new WorkspaceFiles({'/dir/sub/file':'x'}),dir=fs.statSync('/dir'),sub=fs.statSync('/dir/sub')
  expect(dir.nlink).toBe(3)
  now=2000;fs.symlinkSync('sub/file','/dir/link');const link=fs.statSync('/dir/link',false)
  expect(fs.statSync('/dir')).toMatchObject({mtimeMs:2000,ctimeMs:2000})
  expect(fs.statSync('/dir/link').ino).toBe(fs.statSync('/dir/sub/file').ino)
  now=3000;fs.renameSync('/dir','/renamed')
  expect(fs.statSync('/renamed').ino).toBe(dir.ino)
  expect(fs.statSync('/renamed/sub').ino).toBe(sub.ino)
  expect(fs.statSync('/renamed/link',false).ino).toBe(link.ino)
  now=4000;fs.rmSync('/renamed/sub',{recursive:true})
  expect(fs.statSync('/renamed')).toMatchObject({nlink:2,mtimeMs:4000,ctimeMs:4000})
  fs.close()
})

test('failed writes leave metadata intact and snapshot restoration creates new identities',()=>{
  const fs=new WorkspaceFiles({'/a':'123'},6),ref=fs.acquireFileSync('/a'),before=ref.stat(),snapshot=fs.snapshot()
  expect(()=>fs.writeFileSync('/a',bytes('too long'))).toThrow('ENOSPC')
  expect(ref.stat()).toEqual(before)
  fs.replace(snapshot)
  expect(ref.stat().nlink).toBe(0)
  expect(fs.statSync('/a').ino).not.toBe(before.ino)
  ref.close();fs.close()
})
