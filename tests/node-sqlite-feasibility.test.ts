import {expect,test} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'

const require=createRequire(import.meta.url)
const report=JSON.parse(readFileSync('compat/node-sqlite-feasibility.json','utf8'))

test('staged sql.js can run SQLite but its initialized namespace is asynchronous',async()=>{
  const init=require('../fixtures/workloads/node_modules/sql.js/dist/sql-wasm.js')
  const wasmBinary=readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.wasm')
  const pending=init({wasmBinary})
  expect(pending).toBeInstanceOf(Promise)
  const SQL=await pending,db=new SQL.Database()
  try{
    db.run('CREATE TABLE items (value INTEGER)')
    db.run('INSERT INTO items VALUES (?)',[21])
    expect(db.exec('SELECT value * 2 AS answer FROM items')[0].values).toEqual([[42]])
  }finally{db.close()}
})

test('feasibility report matches the current loader and builtin boundaries',()=>{
  const hooks=readFileSync('src/sandbox/guest-module-hooks.js','utf8')
  const bootstrap=readFileSync('src/sandbox/module-bootstrap.js','utf8')
  const build=readFileSync('scripts/build-kernel-builtins.mjs','utf8')
  const builtins=readFileSync('src/compiler/builtins.ts','utf8')
  expect(hooks).toContain("typeof result.source!=='string'")
  expect(hooks).toContain('sources.set(url,{format:result.format,source:result.source')
  expect(bootstrap).toContain("record.kind==='builtin'")
  expect(bootstrap).toContain("record.kind==='builtin'?compileBuiltin(key):compileCommonJS(key,loaded.source)")
  expect(build).toContain("transform(source,{format:'cjs'")
  expect(builtins).toContain("'node:sqlite':")
  expect(report).toMatchObject({schemaVersion:1,feature:'node:sqlite',status:'implemented-with-guest-wasm',implemented:true})
  expect(report.evidence).toEqual({
    sqlJsFactoryWithWasmBinary:'returns-promise',modulePreloadResult:'source-text-only',builtinArtifactFormat:'commonjs',builtinEvaluation:'synchronous',guestWasmInstantiation:'available-after-async-factory-initialization',
  })
  expect(report.smallestArchitecturalChange.component).toBe('kernel process runner')
})
