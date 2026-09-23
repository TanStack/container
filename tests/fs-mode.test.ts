import {test,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import source from '../src/sandbox/guest-fs-types.js?raw'
import {FileDescriptors} from '../src/sandbox/file-descriptors'
import {fileCallSync} from '../src/sandbox/file-capability'

test('directory creation modes survive recursion, rename, references and restoration',()=>{
  const fs=new WorkspaceFiles()
  fileCallSync(fs,true,'mkdir',['/parent',0o777])
  expect(fs.statSync('/parent').mode).toBe(0o40755)
  expect(fileCallSync(fs,true,'mkdir',['/parent/private/child',{recursive:true,mode:'700'}])).toBe('/parent/private')
  expect(fs.statSync('/parent').mode).toBe(0o40755)
  expect(fs.statSync('/parent/private').mode).toBe(0o40700)
  expect(fs.statSync('/parent/private/child').mode).toBe(0o40700)
  const ref=fs.acquireDirectorySync('/parent/private')
  fs.renameSync('/parent/private','/parent/renamed')
  expect(ref.stat().mode).toBe(0o40700)
  const saved=fs.snapshot()
  fs.replace(saved)
  expect(fs.statSync('/parent/renamed').mode).toBe(0o40700)
  expect(fs.statSync('/parent/renamed/child').mode).toBe(0o40700)
  fileCallSync(fs,true,'mkdir',['/parent/renamed',{recursive:true,mode:0o777}])
  expect(fs.statSync('/parent/renamed').mode).toBe(0o40700)
  ref.close();fs.close()
})

test('directory modes validate before mutation and cannot bypass write authority',()=>{
  const fs=new WorkspaceFiles(),before=fs.snapshot()
  for(const mode of [-1,NaN,1.5,0o10000,'888',true]){
    expect(()=>fileCallSync(fs,true,'mkdir',['/new',{mode}])).toThrow('EINVAL')
    expect(fs.snapshot()).toEqual(before)
  }
  expect(()=>fileCallSync(fs,false,'mkdir',['/new',0o777])).toThrow('EACCES')
  expect(fs.snapshot()).toEqual(before)
  fs.close()
})

test('directory mode snapshots reject missing or invalid entries atomically and migrate v4',()=>{
  const fs=new WorkspaceFiles();fs.mkdirSync('/private',false,0o700)
  const before=fs.snapshot()
  if(before.version!==5)throw Error('Expected directory mode snapshot')
  const invalidModes:Record<string,number>[]=[{},{'/':0o755},{'/':0o755,'/other':0o700},{'/':0o755,'/private':-1}]
  for(const directoryModes of invalidModes){
    expect(()=>fs.replace({...before,directoryModes})).toThrow('directory mode')
    expect(fs.snapshot()).toEqual(before)
  }
  fs.replace({version:4,files:before.files,directories:before.directories,symlinks:before.symlinks,fileModes:before.fileModes})
  expect(fs.statSync('/private').mode).toBe(0o40755)
  fs.close()
})

test('creation modes survive writes, rename, open references and checkpoint restoration',()=>{
  const fs=new WorkspaceFiles(),fds=new FileDescriptors(fs)
  const fd=fds.open(1,'/private','w+',true,'600')
  expect(fds.stat(1,fd).mode).toBe(0o100600)
  fs.writeFileSync('/private',new Uint8Array([1]))
  fs.renameSync('/private','/renamed')
  expect(fs.statSync('/renamed').mode).toBe(0o100600)
  const existing=fds.open(1,'/renamed','w',true,0o777)
  expect(fds.stat(1,existing).mode).toBe(0o100600)
  fds.close(1,existing)
  fileCallSync(fs,true,'writeFile',['/executable',new Uint8Array(),{mode:0o777}])
  expect(fs.statSync('/executable').mode).toBe(0o100755)
  const saved=fs.snapshot();fs.unlinkSync('/renamed')
  expect(fds.stat(1,fd).mode).toBe(0o100600)
  fs.replace(saved);expect(fs.statSync('/renamed').mode).toBe(0o100600)
  expect(fs.statSync('/executable').mode).toBe(0o100755)
  fds.close(1,fd);fs.close()
})

test('invalid modes and mode snapshots leave files unchanged; legacy snapshots retain defaults',()=>{
  const fs=new WorkspaceFiles({'/file':'data'}),before=fs.snapshot()
  for(const mode of [-1,0o10000,1.5,NaN,'888',{}]){
    expect(()=>fs.writeFileSync('/file',new Uint8Array(),false,true,mode)).toThrow('EINVAL')
    expect(fs.snapshot()).toEqual(before)
  }
  const invalidModes:Record<string,number>[]=[{},{'/file':-1},{'/other':0o600},{'/file':0o600,'/other':0o600}]
  for(const fileModes of invalidModes){
    expect(()=>fs.replace({...before,version:4,directories:[],symlinks:{},fileModes})).toThrow()
    expect(fs.snapshot()).toEqual(before)
  }
  fs.replace({version:3,files:before.files,directories:[],symlinks:{}})
  expect(fs.statSync('/file').mode).toBe(0o100644)
  fs.close()
})

test('chmod and executable access follow package bin links',()=>{
  const fs=new WorkspaceFiles({'/package/bin.js':'#!/usr/bin/env node\n'})
  fs.mkdirSync('/node_modules/.bin',true)
  fs.symlinkSync('/package/bin.js','/node_modules/.bin/demo')
  expect(()=>fileCallSync(fs,true,'access',['/node_modules/.bin/demo',1])).toThrow('EACCES')
  fileCallSync(fs,true,'chmod',['/node_modules/.bin/demo',0o755])
  expect(fs.statSync('/package/bin.js').mode&0o777).toBe(0o755)
  expect(()=>fileCallSync(fs,true,'access',['/node_modules/.bin/demo',1])).not.toThrow()
  expect(()=>fileCallSync(fs,false,'chmod',['/package/bin.js',0o644])).toThrow('EACCES')
  fs.close()
})

test('workspace stats expose file type and default permission bits to guest consumers',()=>{
  const fs=new WorkspaceFiles({'/dir/file':'content'})
  fs.symlinkSync('/dir/file','/link')
  const {Stats}=new Function('globalThis',source+';return fsTypes')({__webContainerHost:{}})
  for(const [path,follow,mode] of [['/dir/file',true,0o100644],['/dir',true,0o40755],['/link',false,0o120777]] as const){
    const stats=new Stats(fs.statSync(path,follow))
    expect(stats.mode).toBe(mode)
    expect(stats.mode&0o400).toBe(0o400)
    expect(stats.isFile()).toBe((mode&0o170000)===0o100000)
    expect(stats.isDirectory()).toBe((mode&0o170000)===0o40000)
    expect(stats.isSymbolicLink()).toBe((mode&0o170000)===0o120000)
  }
  const ref=fs.acquireFileSync('/dir/file')
  expect(new Stats(ref.stat()).mode).toBe(fs.statSync('/dir/file').mode)
  fs.unlinkSync('/dir/file')
  expect(new Stats(ref.stat()).mode).toBe(0o100644)
  ref.close();fs.close()
})

test('BigInt stats preserve large nanosecond values without floating-point multiplication',()=>{
  const fs=new WorkspaceFiles({'/file':'data'})
  const types=new Function('globalThis',source+';return fsTypes')({__webContainerHost:{}})
  const value={...fs.statSync('/file'),mtimeMs:1750000000123}
  const big=types.stats(value,{bigint:true}),normal=types.stats(value,{bigint:false})
  expect(big.mtimeNs).toBe(1750000000123000000n)
  expect(big.mtimeMs).toBe(1750000000123n)
  expect(big.mtime.getTime()).toBe(value.mtimeMs)
  expect(big.size).toBe(4n)
  expect(big.isFile()).toBe(true)
  expect(big instanceof types.Stats).toBe(false)
  expect(normal instanceof types.Stats).toBe(true)
  expect(normal.size).toBe(4)
  expect(normal.mtimeNs).toBeUndefined()
  fs.close()
})
