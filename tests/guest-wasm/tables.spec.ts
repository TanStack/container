import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const source=[...readFileSync('public/guest-wasm/table-owner.wasm')]
const importer=[...readFileSync('public/guest-wasm/table-import.wasm')]

test('cleared tables release instance memory while retained entries remain callable',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,importer})=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(`
      const source=new WebAssembly.Module(new Uint8Array(${JSON.stringify(source)}));
      const importer=new WebAssembly.Module(new Uint8Array(${JSON.stringify(importer)}));
      const retained=[];
      const live=(()=>new WebAssembly.Instance(source,{host:{callback:n=>n}}).exports.table)();
      for(let n=0;n<600;n++){
        const e=new WebAssembly.Instance(source,{host:{callback:n=>n}}).exports;
        e.clear(0);e.clear(1);retained.push(e.table);
      }
      for(const table of retained)if(table.get(0)!==null||table.get(1)!==null)throw Error('cleared table changed');
      const e=new WebAssembly.Instance(importer,{host:{table:live}}).exports;
      console.log(retained.length,live.get(0)(25),e.call(0,25));
    `,{guestWasm:true,maxBytes:16*1024*1024,timeoutMs:10000})}finally{kernel.close()}
  },{source,importer})
  await info.attach('table-retention.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('600 42 42\n')
})

test('shared table callbacks and growth preserve ALS',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,importer})=>{
    const code=`
      import {AsyncLocalStorage} from 'node:async_hooks';
      const als=new AsyncLocalStorage();
      await als.run('tables',async()=>{
        const {instance}=await WebAssembly.instantiate(new Uint8Array(${JSON.stringify(source)}),{host:{callback:n=>{if(als.getStore()!=='tables')throw Error('lost context');return n}}});
        const a=instance.exports,b=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(importer)})),{host:{table:a.table}}).exports;
        await Promise.resolve();console.log(als.getStore(),b.call(0,25));
        a.table.grow({valueOf(){if(als.getStore()!=='tables')throw Error('lost grow context');return 1}},a.read);
        console.log(b.tail(2,25));
      });console.log(als.getStore()===undefined);
    `
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':code})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true})}finally{kernel.close()}
  },{source,importer})
  await info.attach('table-als.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('tables 42\n42\ntrue\n')
})
