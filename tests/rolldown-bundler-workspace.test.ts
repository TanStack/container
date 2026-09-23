import {expect,test} from 'vitest'
// @ts-expect-error Fixture package exports do not ship declarations for memfs.
import {memfs} from './fixtures/rolldown-native-probe/node_modules/@napi-rs/wasm-runtime/dist/fs.js'
import {WorkspaceFiles} from '../src/sandbox/files'
import {synchronizeBundlerWorkspace,captureBundlerFiles,guardBundlerWrites} from '../src/compiler/rolldown-bundler-workspace'
test('ordered workspace mirror handles create update delete and symlink without replacing volume',()=>{
  const fs=memfs().fs,files=new WorkspaceFiles({'/project/a.js':'before','/project/gone.js':'old'})
  files.symlinkSync('a.js','/project/link.js')
  const limits={maxBytes:1024,maxFiles:16}
  synchronizeBundlerWorkspace(fs,files.snapshot(),limits)
  files.writeFileSync('/project/a.js',new TextEncoder().encode('after'));files.unlinkSync('/project/gone.js');files.writeFileSync('/project/new.js',new TextEncoder().encode('new'))
  synchronizeBundlerWorkspace(fs,files.snapshot(),limits)
  expect(fs.readFileSync('/project/link.js','utf8')).toBe('after')
  expect(fs.existsSync('/project/gone.js')).toBe(false)
  expect(Object.keys(captureBundlerFiles(fs,limits)).sort()).toEqual(['/project/a.js','/project/new.js'])
  files.close()
})
test('native descriptor writes enforce file and byte quota before allocation',()=>{
  const fs=memfs().fs,limits={maxBytes:4,maxFiles:1},restore=guardBundlerWrites(fs,limits)
  try{
    fs.writeFileSync('/a',new Uint8Array([1,2]))
    expect(()=>fs.writeFileSync('/b',new Uint8Array([1]))).toThrow('quota')
    const fd=fs.openSync('/a','r+')
    expect(fs.writeSync(fd,new Uint8Array([3,4]),0,2,2)).toBe(2)
    expect(()=>fs.writeSync(fd,new Uint8Array([5]),0,1,4)).toThrow('quota')
    expect([...fs.readFileSync('/a')]).toEqual([1,2,3,4]);fs.closeSync(fd)
  }finally{restore()}
})
