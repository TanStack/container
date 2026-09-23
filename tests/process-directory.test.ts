import {test,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import {processDirectory,processPath,processFileArguments,watchEventFilename} from '../src/sandbox/process-directory'

test('process paths preserve symlink-sensitive traversal and reject invalid paths',()=>{
  const fs=new WorkspaceFiles({'/project/a/file':'a','/elsewhere/child/file':'b'})
  fs.symlinkSync('/elsewhere/child','/project/link')
  expect(processDirectory(fs,'link/..','/project')).toBe('/elsewhere')
  expect(processDirectory(fs,'a','/project')).toBe('/project/a')
  expect(processPath('/project','a/../file')).toBe('/project/a/../file')
  expect(()=>processDirectory(fs,'a/file','/project')).toThrow('ENOTDIR')
  expect(()=>processDirectory(fs,'missing','/project')).toThrow('ENOENT')
  expect(()=>processDirectory(fs,'../..','/project')).toThrow('EACCES')
  expect(()=>processPath('/project','')).toThrow('ENOENT')
  expect(()=>processPath('/project',null)).toThrow('Expected')
  expect(()=>processPath('/project','C:\\probe')).toThrow(expect.objectContaining({code:'EINVAL'}))
  fs.close()
})

test('both rename paths use cwd but symlink targets stay relative to the link',()=>{
  expect(processFileArguments('/project','rename',['a','b'])).toEqual(['/project/a','/project/b'])
  expect(processFileArguments('/project','copyFile',['a','/b'])).toEqual(['/project/a','/b'])
  expect(processFileArguments('/project','symlink',['links/a','../target'])).toEqual(['/project/links/a','../target'])
})

test('directory watch event names are relative at filesystem and project roots',()=>{
  expect(watchEventFilename('/','/project')).toBe('project')
  expect(watchEventFilename('/','/project/file.ts')).toBe('project/file.ts')
  expect(watchEventFilename('/project','/project/file.ts')).toBe('file.ts')
})
