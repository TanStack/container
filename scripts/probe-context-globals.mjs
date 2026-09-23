import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {probeContextGlobals} from '../fixtures/context-global-cases.mjs'
import {contextGlobalsReference} from './context-globals-reference.mjs'

const directory=resolve(process.argv[2]??'public/quickjs-als-oz')
const patchedLoader=(await import(pathToFileURL(resolve(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>patchedLoader},{wasmBinary:readFileSync(resolve(directory,'engine.wasm'))}))
const reference=contextGlobalsReference(),rows=probeContextGlobals(engine,reference)
const report={generatedAt:new Date().toISOString(),node:process.version,engine:JSON.parse(readFileSync(resolve(directory,'build.json'),'utf8')),scope:'Native engine live-global bridge probe. Not yet wired into the guest node:vm module.',rows}
writeFileSync(process.argv[3]??'reports/context-globals.json',JSON.stringify(report,null,2)+'\n')
for(const row of rows){
  console.log((row.matches?'MATCH':'GAP')+' '+row.name)
  if(!row.matches)for(let i=0;i<row.steps.length;i++)if(JSON.stringify(row.actual[i])!==JSON.stringify(row.expected[i]))console.log(JSON.stringify({step:row.steps[i],actual:row.actual[i],expected:row.expected[i]}))
}
if(rows.some(row=>!row.matches))process.exitCode=1
