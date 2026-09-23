import {test,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import {resolveProcessEntry} from '../src/sandbox/process-entry'

test('node accepts ordinary source files while direct commands require executable permission',()=>{
  const files=new WorkspaceFiles({'/app.mjs':'console.log(42)','/project/script':'console.log(42)'})
  try{
    expect(files.statSync('/app.mjs').mode&0o111).toBe(0)
    expect(resolveProcessEntry(files,'/','/app.mjs',true)).toBe('/app.mjs')
    expect(resolveProcessEntry(files,'/project','script',true)).toBe('/project/script')
    expect(()=>resolveProcessEntry(files,'/','/app.mjs',false)).toThrow(expect.objectContaining({code:'EACCES'}))
    files.chmodSync('/app.mjs',0o755)
    expect(resolveProcessEntry(files,'/','/app.mjs',false)).toBe('/app.mjs')
    files.chmodSync('/project/script',0o755)
    expect(()=>resolveProcessEntry(files,'/','/project/script',false)).toThrow(expect.objectContaining({code:'ENOEXEC'}))
  }finally{files.close()}
})

test('interpreter entry resolution follows symlinks and still requires an existing file',()=>{
  const files=new WorkspaceFiles({'/project/app.js':'console.log(42)','/project/module.mjs':'console.log(43)'})
  try{
    files.symlinkSync('app.js','/project/link')
    expect(resolveProcessEntry(files,'/project','link',true)).toBe('/project/app.js')
    expect(resolveProcessEntry(files,'/project','app',true)).toBe('/project/app.js')
    expect(resolveProcessEntry(files,'/project','module',true)).toBe('/project/module.mjs')
    expect(()=>resolveProcessEntry(files,'/','/missing.js',true)).toThrow(expect.objectContaining({code:'ENOENT'}))
    expect(()=>resolveProcessEntry(files,'/','/project',true)).toThrow(expect.objectContaining({code:'ENOENT'}))
  }finally{files.close()}
})
