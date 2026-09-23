import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {probeContextAllocation} from '../fixtures/allocator-accounting.mjs'

const directory=resolve(process.argv[2]??'public/quickjs-als-oz')
const loader=(await import(pathToFileURL(resolve(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync(resolve(directory,'engine.wasm'))}))
const rows=probeContextAllocation(engine)
writeFileSync(process.argv[3]??'reports/context-allocation.json',JSON.stringify({generatedAt:new Date().toISOString(),engine:JSON.parse(readFileSync(resolve(directory,'build.json'),'utf8')),rows},null,2)+'\n')
if(!rows.some(row=>row.failed)||!rows.some(row=>!row.failed))throw Error('Allocation probe must exercise both failure and success')
console.log(JSON.stringify({attempts:rows.length,allocationFailures:rows.filter(row=>row.failed).length,successes:rows.filter(row=>!row.failed).length}))
