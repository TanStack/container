import {test,expect} from 'vitest'
import {ModuleResolver} from '../src/sandbox/module-resolver'
import {WorkspaceFiles} from '../src/sandbox/files'

test('empty directories are not importable files',()=>{
  const files=new WorkspaceFiles()
  files.mkdirSync('/empty')
  const resolver=new ModuleResolver(files,new Set())
  expect(()=>resolver.resolve('./empty','/entry.mjs')).toThrow('Cannot import directory')
  expect(()=>resolver.resolve('./empty','/entry.cjs','require')).toThrow('Cannot find')
  files.writeFileSync('/empty/index.js',new Uint8Array())
  expect(resolver.resolve('./empty','/entry.cjs','require').path).toBe('/empty/index.js')
})

test('runtime resolver separates Node imports from legacy require paths',()=>{
  const resolver=new ModuleResolver(new WorkspaceFiles({
    '/package.json':'{"type":"module"}','/value.js':'export default 1','/folder/index.js':'',
    '/node_modules/example/package.json':'{"main":"entry.cjs"}','/node_modules/example/entry.cjs':'',
  }),new Set(['node:fs']))
  expect(resolver.resolve('./value.js','/entry.mjs').id).toBe('file:///value.js')
  expect(resolver.resolve('./value','/entry.mjs','require').path).toBe('/value.js')
  expect(()=>resolver.resolve('./value','/entry.mjs')).toThrow('Cannot find')
  expect(()=>resolver.resolve('./folder','/entry.mjs')).toThrow('Cannot import directory')
  expect(resolver.resolve('example','/entry.mjs').kind).toBe('commonjs')
  expect(resolver.resolve('fs').id).toBe('node:fs')
  expect(()=>resolver.resolve('https://example.com/code.mjs')).toThrow('Unsupported module URL')
})

test('package boundaries, null exclusions, imports, and nearest dependencies',()=>{
  const resolver=new ModuleResolver(new WorkspaceFiles({
    '/package.json':'{"imports":{"#x":"./x.cjs"}}','/x.cjs':'',
    '/node_modules/pkg/package.json':JSON.stringify({name:'pkg',exports:{'.':'./entry.mjs','./blocked':null,'./*':'./*.mjs','./escape':'../x.cjs'}}),
    '/node_modules/pkg/entry.mjs':'','/node_modules/pkg/blocked.mjs':'','/node_modules/pkg/ok.mjs':'',
    '/app/node_modules/pkg/package.json':'{"main":"local.cjs"}','/app/node_modules/pkg/local.cjs':'',
  }),new Set())
  expect(resolver.resolve('#x','/entry.mjs','require').path).toBe('/x.cjs')
  expect(resolver.resolve('pkg/ok','/entry.mjs').path).toBe('/node_modules/pkg/ok.mjs')
  expect(()=>resolver.resolve('pkg/blocked','/entry.mjs')).toThrow('not exported')
  expect(()=>resolver.resolve('pkg/escape','/entry.mjs')).toThrow('relative file')
  expect(resolver.resolve('pkg','/app/entry.cjs','require').path).toBe('/app/node_modules/pkg/local.cjs')
  expect(()=>resolver.resolve('file:///a%2fb.js')).toThrow('Invalid workspace file URL')
})

test('bare dot paths are relative directories, not package names',()=>{
  const resolver=new ModuleResolver(new WorkspaceFiles({'/index.js':'','/child/index.js':'','/child/entry.cjs':''}),new Set())
  expect(resolver.resolve('.','/child/entry.cjs','require').path).toBe('/child/index.js')
  expect(resolver.resolve('..','/child/entry.cjs','require').path).toBe('/index.js')
  expect(()=>resolver.resolve('.','/child/entry.mjs','import')).toThrow('Cannot import directory')
  expect(()=>resolver.resolve('..','/child/entry.mjs','import')).toThrow('Cannot import directory')
})

test('exports arrays skip invalid targets but not valid missing files',()=>{
  const resolver=new ModuleResolver(new WorkspaceFiles({
    '/node_modules/pkg/package.json':JSON.stringify({exports:{'.':[null,'../invalid','./ok.mjs'],'./missing':['./missing.mjs','./ok.mjs'],'./disabled':[]}}),
    '/node_modules/pkg/ok.mjs':'',
  }),new Set())
  expect(resolver.resolve('pkg').path).toBe('/node_modules/pkg/ok.mjs')
  expect(()=>resolver.resolve('pkg/missing')).toThrow('Cannot find module')
  expect(()=>resolver.resolve('pkg/disabled')).toThrow('not exported')
})

test('package metadata limits and invalid conditions fail without stale cache',()=>{
  const files=new WorkspaceFiles({
    '/node_modules/pkg/package.json':JSON.stringify({exports:{0:'./ok.mjs',default:'./ok.mjs'}}),
    '/node_modules/pkg/ok.mjs':'',
  })
  const resolver=new ModuleResolver(files,new Set())
  expect(()=>resolver.resolve('pkg')).toThrow('Numeric package conditions')
  files.writeFileSync('/node_modules/pkg/package.json',new TextEncoder().encode(' '.repeat(1024*1024+1)))
  expect(()=>resolver.resolve('pkg')).toThrow('metadata limit')
  files.writeFileSync('/node_modules/pkg/package.json',new TextEncoder().encode('{"exports":"./ok.mjs"}'))
  expect(resolver.resolve('pkg').path).toBe('/node_modules/pkg/ok.mjs')
})
