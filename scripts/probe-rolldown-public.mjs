import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

// Public JavaScript API, explicitly selecting the already installed WASI
// binding through its supported override. No downloads or package mutation.
const source=`
const {rolldown}=await import(${JSON.stringify(pathToFileURL(resolve('fixtures/workloads/node_modules/rolldown/dist/index.mjs')).href)});
const modules={'virtual:main':'import {answer} from "virtual:dep"; export const result=answer+1;',
  'virtual:dep':'export const answer=41; export const unused=999;'};
const bundle=await rolldown({input:'virtual:main',plugins:[{name:'local-fixture',
  resolveId(id){if(id in modules)return id},load(id){return modules[id]}}]});
try{
 const {output}=await bundle.generate({format:'es'});
 const chunks=output.filter(item=>item.type==='chunk');
 if(chunks.length!==1)throw Error('Expected one chunk');
 const executed=await import('data:text/javascript;base64,'+Buffer.from(chunks[0].code).toString('base64'));
 console.log(JSON.stringify({result:executed.result,exports:chunks[0].exports,treeShaken:!chunks[0].code.includes('999')}));
}finally{await bundle.close()}
process.exit(0);
`
const run=spawnSync(process.execPath,['--input-type=module','-e',source],{
  env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:resolve('fixtures/compiler-wasi/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')},
  encoding:'utf8',timeout:15000,
})
assert.equal(run.status,0,run.stderr||run.error?.message)
const result=JSON.parse(run.stdout.trim())
assert.deepEqual(result,{result:42,exports:['result'],treeShaken:true})
console.log(JSON.stringify({scope:'Native Node public Rolldown API with installed WASI binding, not browser acceptance',result}))
