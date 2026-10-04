import {readFileSync,readdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {createRequire} from 'node:module'
import {Volume} from 'memfs'
import {expect,test} from 'vitest'
import * as ts from 'typescript'
import {checkTypeScript} from '../src/native/typescript-check'

const require=createRequire(import.meta.url)
const libDirectory=dirname(require.resolve('typescript/lib/typescript.js'))
function project(source:string){
  const files:Record<string,string>={
    '/app/tsconfig.json':JSON.stringify({compilerOptions:{strict:true,noEmit:true,target:'ES2022',types:[]},include:['src/**/*.ts']}),
    '/app/src/main.ts':source,
  }
  for(const name of readdirSync(libDirectory))if(/^lib\..*\.d\.ts$/.test(name))
    files['/app/node_modules/typescript/lib/'+name]=readFileSync(join(libDirectory,name),'utf8')
  return Volume.fromJSON(files)
}

test('runs installed TypeScript against the virtual workspace',()=>{
  const valid=checkTypeScript(ts,project('export const answer: number = 42'))
  expect(valid.diagnostics).toEqual([])
  const invalid=checkTypeScript(ts,project('export const answer: number = "wrong"'))
  expect(invalid.diagnostics).toContainEqual(expect.objectContaining({code:2322,file:'/app/src/main.ts',line:1}))
})

test('reports configuration errors without writing output',()=>{
  const volume=project('export const answer = 42')
  volume.writeFileSync('/app/tsconfig.json','{"compilerOptions":{"target":"not-a-target"},"include":["src/**/*.ts"]}')
  expect(checkTypeScript(ts,volume).diagnostics.some(diagnostic=>diagnostic.code===6046)).toBe(true)
})

test('loads standard libraries from an installed compiler dependency',()=>{
  const volume=project('export const answer: number = "wrong"')
  volume.mkdirSync('/app/node_modules/@typescript/old/lib',{recursive:true})
  for(const name of readdirSync(libDirectory))if(/^lib\..*\.d\.ts$/.test(name)){
    volume.renameSync('/app/node_modules/typescript/lib/'+name,
      '/app/node_modules/@typescript/old/lib/'+name)
  }
  expect(checkTypeScript(ts,volume,'/app/tsconfig.json','/app/node_modules/@typescript/old/lib').diagnostics)
    .toContainEqual(expect.objectContaining({code:2322,file:'/app/src/main.ts',line:1}))
})
