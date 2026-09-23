import {test,expect} from 'vitest'
// @ts-expect-error Fixture memfs does not ship declarations.
import {memfs} from './fixtures/rolldown-native-probe/node_modules/@napi-rs/wasm-runtime/dist/fs.js'
import {updateCallableWorkspace} from '../src/compiler/callable-workspace-update'
const bytes=(text:string)=>new TextEncoder().encode(text)
test('watch events mirror create update delete and repeated plugin notifications',()=>{
  const {fs}=memfs(),limits={maxBytes:8,maxFiles:3}
  for(const event of ['create','update']){
    updateCallableWorkspace(fs,'/src/a.js',bytes(event==='create'?'one':'two'),event,limits)
    updateCallableWorkspace(fs,'/src/a.js',bytes(event==='create'?'one':'two'),event,limits)
    expect(fs.readFileSync('/src/a.js','utf8')).toBe(event==='create'?'one':'two')
  }
  fs.writeFileSync('/src/generated.js','x')
  updateCallableWorkspace(fs,'/src/generated.js',bytes('yy'),'update',limits)
  updateCallableWorkspace(fs,'/src/a.js',undefined,'delete',limits)
  updateCallableWorkspace(fs,'/src/a.js',undefined,'delete',limits)
  expect(fs.existsSync('/src/a.js')).toBe(false)
  expect(fs.readFileSync('/src/generated.js','utf8')).toBe('yy')
})
test('quota and path failures leave the mirror unchanged',()=>{
  const {fs}=memfs(),limits={maxBytes:3,maxFiles:1}
  fs.writeFileSync('/a','abc')
  expect(()=>updateCallableWorkspace(fs,'/new/b',bytes('x'),'create',limits)).toThrow('quota')
  expect(fs.existsSync('/new')).toBe(false)
  expect(()=>updateCallableWorkspace(fs,'/a',bytes('abcd'),'update',limits)).toThrow('quota')
  expect(fs.readFileSync('/a','utf8')).toBe('abc')
  fs.symlinkSync('/a','/link')
  for(const path of ['/link','/../a','/a/','relative','/a\0'])expect(()=>updateCallableWorkspace(fs,path,undefined,'delete',limits)).toThrow()
  expect(fs.readFileSync('/a','utf8')).toBe('abc')
})
