import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

// Deliberate fault-injection controls, not package compatibility evidence.
for(const mode of ['before-wasm','bare-wasm','caught-import'])test(`Rollup cleanup control: ${mode}`,async({page},info)=>{
  const source=readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/rollup.browser.js','utf8')
  const bytes=[...readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm')]
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,bytes,mode})=>{
    const code=mode==='bare-wasm'?`
      const bytes=await (await fetch('file:///bindings_wasm_bg.wasm')).arrayBuffer();
      console.log('asset',bytes.byteLength);
      const module=new WebAssembly.Module(bytes),imports={};
      console.log('compiled');
      for(const entry of WebAssembly.Module.imports(module))(imports[entry.module]??={})[entry.name]=()=>0;
      console.log('imports');
      try{new WebAssembly.Instance(module,imports);throw Error('INJECTED_AFTER_INSTANCE')}catch(e){console.log('caught',e.message)}
    `:`${mode==='before-wasm'?`WebAssembly.instantiate=async()=>{throw Error('INJECTED_REJECTION')};`:''}
      try{const {rollup}=await import('./rollup.js');const bundle=await rollup({input:'main',plugins:[{name:'fixture',resolveId:id=>id,load:()=> 'globalThis.answer=42'}]});try{throw Error('INJECTED_AFTER_ROLLUP')}finally{await bundle.close()}}catch(e){console.log('caught',e.message)};`
    const kernel=new window.sandboxLab.WorkerKernel({'/package.json':'{"type":"module"}','/rollup.js':source,'/bindings_wasm_bg.wasm':new Uint8Array(bytes),'/main.mjs':code})
    let output=''
    try{return {result:await kernel.runModule('/main.mjs',{webAPIs:true,workspaceFetch:true,guestWasm:true,maxBytes:64*1024*1024,timeoutMs:10000,onOutput:(_level,text)=>{output+=text}}),output}}
    catch(error){return {error:String(error),output}}finally{kernel.close()}
  },{source,bytes,mode})
  await info.attach('cleanup-control.json',{body:JSON.stringify({mode,...result}),contentType:'application/json'})
  expect(result.error,result.output).toBeUndefined()
  expect(result.result?.exitCode,result.result?.stderr).toBe(0)
  expect(result.output).toContain(mode==='before-wasm'?'caught INJECTED_REJECTION':mode==='bare-wasm'?'caught INJECTED_AFTER_INSTANCE':'caught INJECTED_AFTER_ROLLUP')
})
