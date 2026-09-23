import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

const wasmCSS=process.env.VITE_WASM_CSS==='1'
const dependencies=wasmCSS?'fixtures/vite-rolldown-wasm':'fixtures/workloads'
const source=`
const {build}=await import(${JSON.stringify(pathToFileURL(resolve(dependencies+'/node_modules/vite/dist/node/index.js')).href)});
const result=await build({root:${JSON.stringify(resolve('fixtures/vite-rolldown-basic'))},configFile:false,logLevel:'silent',build:{write:false,sourcemap:true}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(result=>result.output);
console.log(JSON.stringify(outputs.map(item=>({type:item.type,fileName:item.fileName,content:item.type==='chunk'?item.code:typeof item.source==='string'?item.source:Buffer.from(item.source).toString('utf8')}))));
process.exit(0);
`
const run=spawnSync(process.execPath,['--input-type=module','-e',source],{
  env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:resolve('fixtures/compiler-wasi/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')},
  encoding:'utf8',timeout:15000,
})
assert.equal(run.status,0,run.stderr||run.error?.message)
const outputs=JSON.parse(run.stdout.trim())
assert.ok(outputs.some(item=>item.fileName==='index.html'&&item.content.includes('type="module"')))
assert.ok(outputs.some(item=>item.fileName.endsWith('.css')&&item.content.includes('#app')))
assert.ok(outputs.some(item=>item.type==='chunk'&&item.content.includes('vite-rolldown-ready:')))
assert.ok(outputs.some(item=>item.fileName.endsWith('.map')&&JSON.parse(item.content).version===3))
assert.ok(outputs.every(item=>item.type!=='chunk'||!item.content.includes('UNUSED_VITE_FIXTURE')))
console.log(JSON.stringify({scope:'Native Vite build with installed WASI Rolldown, not browser acceptance',cssCompiler:wasmCSS?'Declared lightningcss alias to official lightningcss-wasm@1.33.0':'Installed native LightningCSS addon',outputs:outputs.map(({type,fileName,content})=>({type,fileName,bytes:Buffer.byteLength(content)}))},null,2))
