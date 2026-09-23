import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {probeAllocatorAccounting} from '../fixtures/allocator-accounting.mjs'

const directory=resolve(process.argv[2]??'public/quickjs-als-oz')
const loader=(await import(pathToFileURL(resolve(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync(resolve(directory,'engine.wasm'))}))
const report={generatedAt:new Date().toISOString(),engine:JSON.parse(readFileSync(resolve(directory,'build.json'),'utf8')),...probeAllocatorAccounting(engine)}
writeFileSync(process.argv[3]??'reports/allocator-accounting.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report.rows,null,2))
if(report.rows.some(row=>!row.enforced))process.exitCode=1
