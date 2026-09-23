import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`${guestWasm?'WASM bridge':'default engine'}: child inherits approved memory and cannot override it`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async guestWasm=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`
      import {execFile,spawn} from 'node:child_process';
      for(const option of ['maxBytes','timeoutMs']){
        try{spawn(process.execPath,['-e',''],{[option]:512*1024*1024});throw Error('accepted override')}
        catch(error){if(error.code!=='ERR_UNSUPPORTED_OPERATION')throw error}
      }
      const output=await new Promise((resolve,reject)=>execFile(process.execPath,['-e','const bytes=new Uint8Array(24*1024*1024);bytes[0]=42;console.log(bytes.length,bytes[0])'],(error,stdout)=>error?reject(error):resolve(stdout)));
      console.log(output.trim());
    `},{maxBytes:64*1024*1024})
    try{return await kernel.runModule('/main.mjs',{guestWasm,maxBytes:64*1024*1024})}finally{kernel.close()}
  },guestWasm)
  await info.attach('child-budget.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('25165824 42\n')
})
