import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {probeContextPrimitives} from '../fixtures/context-primitives.mjs'
import {contextPrimitiveReference} from './context-primitives-reference.mjs'

const directory=resolve(process.argv[2]??'public/quickjs-als')
const patchedLoader=(await import(pathToFileURL(resolve(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...RELEASE_SYNC,importModuleLoader:async()=>patchedLoader},{wasmBinary:readFileSync(resolve(directory,'engine.wasm'))}))
const reference=contextPrimitiveReference()
const rows=probeContextPrimitives(engine,readFileSync('src/sandbox/engine-als-bootstrap.js','utf8'),reference)
const report={generatedAt:new Date().toISOString(),node:process.version,engine:JSON.parse(readFileSync(resolve(directory,'build.json'),'utf8')),scope:'Host-side engine primitive probe, not browser node:vm support',reference,rows}
writeFileSync(process.argv[3]??'reports/context-primitives.json',JSON.stringify(report,null,2)+'\n')
for(const row of rows)console.log((row.matches?'MATCH':'GAP')+' '+row.name+': '+JSON.stringify(row.actual))
if(rows.some(row=>!row.matches))process.exitCode=1
