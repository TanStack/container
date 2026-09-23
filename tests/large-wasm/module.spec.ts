import {test,expect} from '@playwright/test'

test('large module compiles repeatedly and malformed input recovers',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`
      const size=14*1024*1024,leb=[];let n=size;
      do{const b=n&127;n>>>=7;leb.push(b|(n?128:0))}while(n);
      const bytes=new Uint8Array(9+leb.length+size);bytes.set([0,97,115,109,1,0,0,0,0,...leb]);
      for(let i=0;i<3;i++){
        const module=new WebAssembly.Module(bytes);
        if(Object.keys(new WebAssembly.Instance(module).exports).length)throw Error('unexpected exports');
        bytes[0]=1;
        try{new WebAssembly.Module(bytes);throw Error('accepted malformed module')}
        catch(error){if(!(error instanceof WebAssembly.CompileError))throw error}
        bytes[0]=0;
      }
      console.log('large module passed');
    `},{maxBytes:128*1024*1024})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,maxBytes:128*1024*1024})}finally{kernel.close()}
  })
  await info.attach('large-module.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('large module passed\n')
})
