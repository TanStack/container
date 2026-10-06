import test from 'node:test'
import assert from 'node:assert/strict'
import {statSync,lstatSync} from 'node:fs'
import {createNativeFilesystemBackend} from '../src/native/filesystem-backend.mjs'

const outcome=(fn,path,options)=>{
  try{const stat=fn(path,options);return stat===undefined?{missing:true}:{file:stat.isFile(),link:stat.isSymbolicLink()}}
  catch(error){return {code:error.code}}
}

test('owned optional stat matches native Node for missing files and file-as-parent paths',()=>{
  const {fs}=createNativeFilesystemBackend({'/app/base':'file'})
  for(const [nodePath,volumePath] of [['README.md/child','/app/base/child'],
    ['README.md/../missing-optional-stat-control','/app/base/../missing-optional-stat-control']]){
    assert.deepEqual(outcome(fs.statSync,volumePath,{throwIfNoEntry:false}),outcome(statSync,nodePath,{throwIfNoEntry:false}))
  }
})

test('owned optional lstat preserves Node distinction for a file-as-parent path',()=>{
  const {fs}=createNativeFilesystemBackend({'/app/base':'file'})
  assert.deepEqual(outcome(fs.lstatSync,'/app/base/child',{throwIfNoEntry:false}),
    outcome(lstatSync,'README.md/child',{throwIfNoEntry:false}))
  assert.equal(outcome(fs.lstatSync,'/app/base/child',{throwIfNoEntry:false}).code,'ENOTDIR')
  assert.equal(fs.lstatSync('/app/missing',{throwIfNoEntry:false}),undefined)
})

test('owned required stat and lstat still throw their native error codes',()=>{
  const {fs}=createNativeFilesystemBackend({'/app/base':'file'})
  for(const method of ['statSync','lstatSync'])for(const options of [undefined,{}, {throwIfNoEntry:true}]){
    assert.throws(()=>fs[method]('/app/base/child',options),{code:'ENOTDIR'})
    assert.throws(()=>fs[method]('/app/missing',options),{code:'ENOENT'})
  }
})

test('owned optional metadata preserves file, link, bigint and timestamp results',()=>{
  const {fs,vol}=createNativeFilesystemBackend({'/app/value':'data'})
  vol.symlinkSync('/app/value','/app/alias')
  const direct=fs.statSync('/app/value'),followed=fs.statSync('/app/alias',{throwIfNoEntry:false})
  assert.equal(followed.isFile(),true);assert.equal(followed.ino,direct.ino);assert.equal(followed.size,4)
  assert.equal(followed.mtimeMs,direct.mtimeMs);assert.ok(followed.mtime instanceof Date)
  assert.equal(fs.lstatSync('/app/alias',{throwIfNoEntry:false}).isSymbolicLink(),true)
  assert.equal(fs.statSync('/app/alias',{bigint:true,throwIfNoEntry:false}).size,4n)
})

test('owned optional stat sees dangling links and later retargeting without a cache',()=>{
  const {fs,vol}=createNativeFilesystemBackend({'/app/value':'data'})
  vol.symlinkSync('/app/value','/app/alias');assert.equal(fs.statSync('/app/alias',{throwIfNoEntry:false}).size,4)
  vol.unlinkSync('/app/value');assert.equal(fs.statSync('/app/alias',{throwIfNoEntry:false}),undefined)
  vol.writeFileSync('/app/value','new data');assert.equal(fs.statSync('/app/alias',{throwIfNoEntry:false}).size,8)
})

test('owned optional stat does not hide path validation failures',()=>{
  const {fs}=createNativeFilesystemBackend()
  for(const path of [null,{},new URL('https://example.test/file')])
    assert.throws(()=>fs.statSync(path,{throwIfNoEntry:false}))
})
