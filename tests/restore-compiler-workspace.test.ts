import {test,expect} from 'vitest'
import {memfs} from 'memfs'
import {WorkspaceFiles} from '../src/sandbox/files'
import {restoreCompilerWorkspace} from '../src/compiler/restore-compiler-workspace'

test('compiler snapshot preserves binary files, empty directories, links and modes',()=>{
  const workspace=new WorkspaceFiles({'/project/data':new Uint8Array([0,255,42])})
  try{
    workspace.mkdirSync('/project/empty',true)
    workspace.symlinkSync('data','/project/link')
    workspace.chmodSync('/project/data',0o640)
    workspace.chmodSync('/project/empty',0o750)
    const {fs}=memfs()
    expect(restoreCompilerWorkspace(fs,workspace.snapshot(),{maxBytes:1024,maxFiles:20})).toEqual({files:1,bytes:3})
    expect([...fs.readFileSync('/project/link') as Uint8Array]).toEqual([0,255,42])
    expect(fs.readlinkSync('/project/link')).toBe('data')
    expect(fs.readdirSync('/project/empty')).toEqual([])
    expect(Number(fs.statSync('/project/data').mode)&0o777).toBe(0o640)
    expect(Number(fs.statSync('/project/empty').mode)&0o777).toBe(0o750)
  }finally{workspace.close()}
})

test('rejects oversized snapshots before writing compiler files',()=>{
  const {fs}=memfs()
  expect(()=>restoreCompilerWorkspace(fs,{version:1,files:{'/big':new Uint8Array(10)}},{maxBytes:2,maxFiles:10})).toThrow()
  expect(fs.readdirSync('/')).toEqual([])
})

test('does not overwrite an existing compiler filesystem',()=>{
  const {fs}=memfs({'/existing':'keep'})
  expect(()=>restoreCompilerWorkspace(fs,{version:1,files:{}},{maxBytes:100,maxFiles:10})).toThrow('must be empty')
  expect(fs.readFileSync('/existing','utf8')).toBe('keep')
})
