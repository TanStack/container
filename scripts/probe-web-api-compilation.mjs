import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from 'playwright'

const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd-lazy-wasm')
const startModules=process.argv.includes('--start-modules')
const sources=(startModules?[
 'fixtures/start-vite8-wasm/node_modules/vite/dist/node/chunks/node.js',
 'fixtures/start-vite8-wasm/node_modules/prettier/plugins/typescript.mjs',
 'fixtures/start-vite8-wasm/node_modules/prettier/index.mjs',
 'fixtures/start-vite8-wasm/node_modules/@emnapi/core/dist/emnapi-core.js',
]:['public/vm-web-apis/globals.js']).map(path=>({path,source:readFileSync(path,'utf8')}))
const results=[]
const server=createServer((req,res)=>{
  if(req.url==='/'){
    res.setHeader('content-type','text/html')
    res.end(`<script type="module">
import * as core from '/core.mjs';import factory from '/engine.mjs';import {QuickJSAsyncFFI} from '/ffi.mjs';
try{
 const bytes=await(await fetch('/engine.wasm')).arrayBuffer();
 const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:bytes})});
 const sources=await(await fetch('/sources.json')).json(),rows=[];
 for(const {path,source} of sources)for(let index=0;index<3;index++){
  const runtime=engine.newRuntime(),context=runtime.newContext();
  let imports=0;
  // Only the selected module is measured. Dependencies are empty compile-only
  // placeholders, never executed, so this is not module graph compatibility.
  if(${startModules})runtime.setModuleLoader(()=>{imports++;return ''},(_base,name)=>name);
  runtime.setMemoryLimit(128*1024*1024);runtime.setMaxStackSize(512*1024);
  const deadline=performance.now()+15000;runtime.setInterruptHandler(()=>performance.now()>deadline);
  try{
   const start=performance.now();
   const result=context.evalCode(source,path,{compileOnly:true,type:${JSON.stringify(startModules?'module':'global')}});
   const compileMs=performance.now()-start;
   try{if(result.error)throw Error(JSON.stringify(context.dump(result.error)))}finally{result.dispose()}
   const probe=context.unwrapResult(context.evalCode('typeof globalThis.Request'));
   try{if(context.getString(probe)!=='undefined')throw Error('Compile-only executed source')}finally{probe.dispose()}
   rows.push({path,index,compileMs,imports});
  }finally{context.dispose();runtime.dispose()}
 }
 window.result=rows;
}catch(error){window.failure=String(error)}
</script>`);return
  }
  if(req.url==='/sources.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify(sources));return}
  if(['/core.mjs','/ffi.mjs','/engine.mjs','/engine.wasm'].includes(req.url)){
    res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
    res.end(readFileSync(join(root,req.url.slice(1))));return
  }
  res.statusCode=404;res.end()
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
try{
 for(const [name,type] of Object.entries({chromium,firefox,webkit})){
  const browser=await type.launch()
  try{
   const page=await browser.newPage()
   await page.goto(`http://127.0.0.1:${server.address().port}/`)
   await page.waitForFunction(()=>window.result||window.failure,null,{timeout:60000})
   const observed=await page.evaluate(()=>({rows:window.result,error:window.failure}))
   results.push({name,...observed});console.log(JSON.stringify(results.at(-1)))
   if(observed.error)process.exitCode=1
  }finally{await browser.close()}
 }
}finally{
 await new Promise(done=>server.close(done))
 writeFileSync(startModules?'reports/start-module-compilation.json':'reports/web-api-compilation.json',JSON.stringify({scope:startModules?'Individual unmodified module compile-only cost with empty dependency placeholders, not dependency graph execution or framework compatibility.':'Compile-only startup cost in fresh contexts, not bytecode reuse or full application performance.',engine:root,sources:sources.map(({path,source})=>({path,chars:source.length,sha256:createHash('sha256').update(source).digest('hex')})),results},null,2)+'\n')
}
