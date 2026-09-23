import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const source=[...readFileSync('public/guest-wasm/global-values.wasm')]
const importer=[...readFileSync('public/guest-wasm/global-import.wasm')]

test('retained numeric globals do not retain discarded instance memory',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,importer})=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(`
      const source=new WebAssembly.Module(new Uint8Array(${JSON.stringify(source)}));
      const importer=new WebAssembly.Module(new Uint8Array(${JSON.stringify(importer)}));
      const retained=[];
      for(let n=0;n<600;n++){
        const e=new WebAssembly.Instance(source).exports;
        e.i.value=n;retained.push(e.alias);
      }
      for(let n=0;n<retained.length;n++)if(retained[n].value!==n)throw Error('global lost');
      const value=retained[42];
      const e=new WebAssembly.Instance(importer,{host:{value,constant:23,long:1n}}).exports;
      if(e.bump()!==43||value.value!==43)throw Error('shared global lost');
      console.log(retained.length,e.read(),retained[599].value);
    `,{guestWasm:true,maxBytes:16*1024*1024,timeoutMs:10000})}finally{kernel.close()}
  },{source,importer})
  await info.attach('global-retention.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('600 43 599\n')
})

test('global mutations preserve ALS across callbacks and async instantiation',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async importer=>{
    const source=`
      import {AsyncLocalStorage} from 'node:async_hooks';
      const als=new AsyncLocalStorage();
      await als.run('globals',async()=>{
        const value=new WebAssembly.Global({value:'i32',mutable:true},7);
        const {instance}=await WebAssembly.instantiate(new Uint8Array(${JSON.stringify(importer)}),{host:{value,constant:23,long:1n}});
        value.value={valueOf(){console.log(als.getStore(),instance.exports.bump());return 41}};
        await Promise.resolve();console.log(als.getStore(),instance.exports.bump(),value.value);
      });console.log(als.getStore()===undefined);
    `
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true})}finally{kernel.close()}
  },importer)
  await info.attach('global-als.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('globals 8\nglobals 42 42\ntrue\n')
})
