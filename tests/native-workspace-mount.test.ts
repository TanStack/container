import {expect,test} from 'vitest'
import {mountNativeWorkspaceFiles} from '../src/native/workspace-mount'
test('mounts a host workspace without accepting sibling or ambiguous paths',()=>{
  const bytes=new Uint8Array([42])
  expect(mountNativeWorkspaceFiles({'/project/package.json':'{}','/project/file':bytes},'/project')).toEqual({'/app/package.json':'{}','/app/file':bytes})
  for(const path of ['/project-other/file','/project/../file','/project//file','/project/file\\x'])expect(()=>mountNativeWorkspaceFiles({[path]:''},'/project')).toThrow()
  for(const root of ['/','/a/b','/..'])expect(()=>mountNativeWorkspaceFiles({},root)).toThrow()
})
